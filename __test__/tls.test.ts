import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';

import { Server } from '../js/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CERT = readFileSync(join(here, 'fixtures/cert.pem'), 'utf8');
const KEY = readFileSync(join(here, 'fixtures/key.pem'), 'utf8');

// The ports are deliberately below 32768: on Linux the ephemeral range starts at 32768,
// so a test using listen({port:0}) could be handed exactly our fixed port by the kernel.
// On macOS the range starts at 49152, which is why this never reproduced locally.
let PORT = 20900;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, close: () => server.close() };
}

/** HTTP/2 client (TLS or h2c) → a single GET. */
function h2get(url, opts = {}) {
  return new Promise<any>((resolve, reject) => {
    const client = http2.connect(url, opts);
    client.on('error', reject);
    const req = client.request({ ':path': '/' });
    let data = '';
    let headers;
    req.on('response', (h) => (headers = h));
    req.setEncoding('utf8');
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      client.close();
      resolve({ status: headers[':status'], protocol: 'h2', body: data });
    });
    req.end();
  });
}

test('M9: TLS + ALPN → HTTP/2', async () => {
  const s = await up({
    config: { tls: { cert: CERT, key: KEY } },
    routes: (app) => app.get('/', (c) => c.json({ proto: 'via-alpn' })),
  });
  try {
    const res = await h2get(`https://127.0.0.1:${s.port}`, { ca: CERT });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { proto: 'via-alpn' });
  } finally {
    s.close();
  }
});

test('M9: TLS + HTTP/1.1 fallback', async () => {
  const s = await up({
    config: { tls: { cert: CERT, key: KEY } },
    routes: (app) => app.get('/', (c) => c.text('h1-over-tls')),
  });
  try {
    // alpnProtocol lives on the socket, not on IncomingMessage. We carry it into the
    // resolved value instead of asserting inside the callback: a throw there would abort
    // reading the response and leave the TLS socket open (the test process would hang).
    const { body, alpn } = await new Promise<any>((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port: s.port, path: '/', ca: CERT, ALPNProtocols: ['http/1.1'] } as any,
        (res: any) => {
          const alpn = (res.socket as any).alpnProtocol;
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ body: d, alpn }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(alpn, 'http/1.1');
    assert.equal(body, 'h1-over-tls');
  } finally {
    s.close();
  }
});

test('M9: h2c prior-knowledge (plaintext HTTP/2)', async () => {
  const s = await up({
    config: { h2c: true },
    routes: (app) => app.get('/', (c) => c.json({ h2c: true })),
  });
  try {
    const res = await h2get(`http://127.0.0.1:${s.port}`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { h2c: true });
  } finally {
    s.close();
  }
});

test('M9: a cert from a Buffer loads', async () => {
  const s = await up({
    config: { tls: { cert: Buffer.from(CERT), key: Buffer.from(KEY) } },
    routes: (app) => app.get('/', (c) => c.text('buf-ok')),
  });
  try {
    const body = await new Promise<any>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: s.port, path: '/', ca: CERT }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'buf-ok');
  } finally {
    s.close();
  }
});

test('M9: Slowloris — slow headers are cut off by the timeout', async () => {
  const s = await up({
    config: { headerReadTimeout: '200ms' },
    routes: (app) => app.get('/', (c) => c.text('ok')),
  });
  try {
    const closed = await new Promise<any>((resolve) => {
      const socket = net.connect(s.port, '127.0.0.1');
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          socket.destroy();
          resolve(v);
        }
      };
      socket.on('connect', () => {
        // Send the start of a request and do NOT terminate the headers.
        socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
        // no final \r\n — the server must close on timeout
      });
      socket.on('close', () => finish('closed'));
      socket.on('end', () => finish('closed'));
      setTimeout(() => finish('still-open'), 1500);
    });
    assert.equal(closed, 'closed', 'the connection must close on headerReadTimeout');
  } finally {
    s.close();
  }
});

test('M9: HTTP/2 with settings (maxConcurrentStreams, initialWindowSize)', async () => {
  const s = await up({
    config: {
      h2c: true,
      http2: { maxConcurrentStreams: 100, initialWindowSize: '1mb', maxResetStreamsPerSec: 50 },
    },
    routes: (app) => app.get('/', (c) => c.text('tuned')),
  });
  try {
    const res = await h2get(`http://127.0.0.1:${s.port}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'tuned');
  } finally {
    s.close();
  }
});

/** Raw HTTP/1.1 request over a socket; resolves with the raw response (or '' if cut).
 *  `write(socket, stop)` is the writer; `stop()` returns true once the response has
 *  arrived and writing should cease (otherwise closing with unread data yields RST). */
function raw(port, write, waitMs = 3000) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(data);
    };
    socket.on('connect', () => write(socket, () => data.length > 0));
    socket.on('data', (d) => (data += d));
    socket.on('close', finish);
    socket.on('error', (e) => (done ? null : (done = true), reject(e)));
    setTimeout(finish, waitMs);
  });
}

test('M9: maxHeaderSize exceeded → 431', async () => {
  const s = await up({
    config: { maxHeaderSize: '8kb' },
    routes: (app) => app.get('/', (c) => c.text('ok')),
  });
  try {
    // Write the header in chunks and stop as soon as the response arrives: hyper answers
    // 431 and closes the connection, and an unwritten tail would turn that close into an
    // RST — the client would lose the response it already received (ECONNRESET).
    const res = await raw(s.port, (sock, stop) => {
      sock.write('GET / HTTP/1.1\r\nHost: x\r\nX-Big: ');
      let sent = 0;
      const pump = () => {
        if (stop() || sent++ >= 32) return;
        sock.write('x'.repeat(1024), () => setTimeout(pump, 5));
      };
      pump();
    });
    assert.match(res, /^HTTP\/1\.1 431 /, `expected 431, got: ${res.slice(0, 60)}`);
  } finally {
    s.close();
  }
});

test('M9: bodyReadTimeout — silence mid-body → 408', async () => {
  const s = await up({
    config: { bodyReadTimeout: '300ms' },
    routes: (app) => app.post('/', async (c) => c.text(await c.req.text())),
  });
  try {
    // Declare 100 bytes, send 5 and go quiet — the server must not wait forever.
    const res = await raw(s.port, (sock) => {
      sock.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nhello');
    });
    assert.match(res, /^HTTP\/1\.1 408 /, `expected 408, got: ${res.slice(0, 60)}`);
  } finally {
    s.close();
  }
});

test('A4: a negative timeout is a config error, 0 disables it', async () => {
  // A typo used to reach Rust and be filtered out there, turning `-5000` into
  // "protection off". The unit parser rejects it first; the native layer now refuses it
  // too, for anything that bypasses the wrapper.
  assert.throws(() => new Server({ bodyReadTimeout: -5000 }), /invalid number/);

  // 0 is the explicit way to switch a protective timeout off.
  const off = new Server({ idleTimeout: 0 });
  off.get('/', (c) => c.text('ok'));
  const port = nextPort();
  await off.listen({ port, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await res.text(), 'ok');
  } finally {
    await off.close();
  }
});

test('M9: idleTimeout closes an idle keep-alive connection', async () => {
  const s = await up({
    config: { idleTimeout: '400ms' },
    routes: (app) => app.get('/', (c) => c.text('ok')),
  });
  try {
    const t0 = Date.now();
    // One normal request, then silence — the server must close the connection.
    const res = await raw(
      s.port,
      (sock) => sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
      3000,
    );
    const elapsed = Date.now() - t0;
    assert.match(res, /^HTTP\/1\.1 200 /);
    assert.ok(elapsed < 2000, `the connection must close on idleTimeout, elapsed ${elapsed}ms`);
  } finally {
    s.close();
  }
});

test('M9: idleTimeout does not cut a long request (in-flight is not idle)', async () => {
  const s = await up({
    config: { idleTimeout: '300ms' },
    routes: (app) =>
      app.get('/slow', async (c) => {
        // The handler thinks longer than idleTimeout and writes nothing to the socket.
        await new Promise<void>((r) => setTimeout(r, 900));
        return c.text('slow-ok');
      }),
  });
  try {
    const res = await raw(s.port, (sock) => sock.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n'));
    assert.match(res, /^HTTP\/1\.1 200 /, `the request must not be cut off: ${res.slice(0, 60)}`);
    assert.match(res, /slow-ok/);
  } finally {
    s.close();
  }
});
