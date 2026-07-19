import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

import { Server } from '../js/index.ts';

let PORT = 21200;
const nextPort = () => PORT++;
let SOCK = 0;
const nextSock = () => join(tmpdir(), `oxide-http-test-${process.pid}-${SOCK++}.sock`);

async function up(build) {
  const server = new Server(build.config ?? {});
  build.routes(server);
  const target = build.listen ?? { port: nextPort(), host: '127.0.0.1' };
  await server.listen(target);
  return { ...target, server, close: () => server.close() };
}

/** Raw TCP request: write the bytes as-is, collect the response until close. */
function raw(port, payload, waitMs = 2000) {
  return new Promise<any>((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(data);
    };
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (d) => (data += d));
    sock.on('close', finish);
    // ECONNRESET is a legitimate outcome: the server closed the connection without
    // reading our request fully (connection limit, missing PROXY prefix). Return
    // whatever we managed to receive.
    sock.on('error', (e: any) => {
      if (done) return;
      if (e.code === 'ECONNRESET') return finish();
      done = true;
      reject(e);
    });
    setTimeout(finish, waitMs);
  });
}

// --- Unix socket ---

test('M10c: the server listens on a Unix socket', async () => {
  const path = nextSock();
  const s = await up({
    listen: { path },
    routes: (app) => app.get('/hi', (c) => c.json({ via: 'unix' })),
  });
  try {
    const body = await new Promise<any>((resolve, reject) => {
      const req = http.request({ socketPath: path, path: '/hi' }, (res) => {
        let d = '';
        res.on('data', (chunk) => (d += chunk));
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.end();
    });
    assert.deepEqual(JSON.parse(body), { via: 'unix' });
  } finally {
    await s.close();
    rmSync(path, { force: true });
  }
});

test('M10c: a stale socket file does not block startup', async () => {
  const path = nextSock();
  // The first server leaves the socket file on disk (as after a SIGKILL).
  const first = await up({ listen: { path }, routes: (app) => app.get('/', (c) => c.text('1')) });
  await first.close();
  assert.ok(existsSync(path), 'the socket file remains after closing');

  const second = await up({ listen: { path }, routes: (app) => app.get('/', (c) => c.text('2')) });
  try {
    const body = await new Promise<any>((resolve, reject) => {
      const req = http.request({ socketPath: path, path: '/' }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, '2', 'the second server must reuse the path');
  } finally {
    await second.close();
    rmSync(path, { force: true });
  }
});

// --- PROXY protocol (§6c A4) ---

test('M10c: PROXY v1 → c.req.ip is the real client address', async () => {
  const s = await up({
    config: { proxyProtocol: true },
    routes: (app) => app.get('/ip', (c) => c.text(c.req.ip)),
  });
  try {
    const res = await raw(
      s.port,
      'PROXY TCP4 203.0.113.7 10.0.0.1 56324 443\r\nGET /ip HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    );
    assert.match(res, /^HTTP\/1\.1 200 /);
    assert.ok(res.endsWith('203.0.113.7'), `expected the IP from the prefix, got: ${res.slice(-40)}`);
  } finally {
    await s.close();
  }
});

test('M10c: PROXY v2 (binary) → c.req.ip is the real address', async () => {
  const s = await up({
    config: { proxyProtocol: true },
    routes: (app) => app.get('/ip', (c) => c.text(c.req.ip)),
  });
  try {
    const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
    const head = Buffer.from([0x21, 0x11, 0x00, 0x0c]); // v2/PROXY, AF_INET/STREAM, len=12
    const addrs = Buffer.from([198, 51, 100, 23, 10, 0, 0, 1, 0x1f, 0x90, 0x01, 0xbb]);
    const req = Buffer.from('GET /ip HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');

    const res = await raw(s.port, Buffer.concat([sig, head, addrs, req]));
    assert.match(res, /^HTTP\/1\.1 200 /);
    assert.ok(res.endsWith('198.51.100.23'), `expected the IP from the prefix, got: ${res.slice(-40)}`);
  } finally {
    await s.close();
  }
});

test('M10c: proxyProtocol on, no prefix → the connection is closed', async () => {
  const s = await up({
    config: { proxyProtocol: true },
    routes: (app) => app.get('/ip', (c) => c.text(c.req.ip)),
  });
  try {
    // Plain HTTP without a prefix: a client bypassing the balancer must not be served.
    const res = await raw(s.port, 'GET /ip HTTP/1.1\r\nHost: x\r\n\r\n', 1000);
    assert.equal(res, '', `there must be no response, got: ${res.slice(0, 60)}`);
  } finally {
    await s.close();
  }
});

test('M10c: the PROXY prefix does not break the customIpHeaders chain', async () => {
  const s = await up({
    config: { proxyProtocol: true, customIpHeaders: ['x-forwarded-for'] },
    routes: (app) => app.get('/ip', (c) => c.text(c.req.ip)),
  });
  try {
    // The header outranks the prefix address (§7: PROXY first, then headers).
    const res = await raw(
      s.port,
      'PROXY TCP4 203.0.113.7 10.0.0.1 56324 443\r\n' +
        'GET /ip HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 8.8.8.8, 1.1.1.1\r\nConnection: close\r\n\r\n',
    );
    assert.ok(res.endsWith('8.8.8.8'), `expected the IP from the header, got: ${res.slice(-40)}`);
  } finally {
    await s.close();
  }
});

// --- socket options (§6c B9) ---

test('M10c: maxConnections rejects surplus connections', async () => {
  const s = await up({
    config: { maxConnections: 2 },
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 400));
        return c.text('ok');
      }),
  });
  try {
    // Two connections take up the limit and hold it with requests.
    const busy = [1, 2].map(
      () =>
        new Promise<any>((resolve) => {
          const sock = net.connect(s.port, '127.0.0.1');
          sock.on('connect', () => sock.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n'));
          sock.on('data', () => resolve(sock));
          sock.on('error', () => resolve(sock));
        }),
    );
    await new Promise<void>((r) => setTimeout(r, 150));

    // The third must be closed by the server immediately, with no response.
    const third = await raw(s.port, 'GET /slow HTTP/1.1\r\nHost: x\r\n\r\n', 1200);
    assert.equal(third, '', `the third connection must not be served, got: ${third.slice(0, 40)}`);

    for (const p of busy) (await p).destroy();
  } finally {
    await s.close();
  }
});

test('M10c: reusePort — two servers on one port', async () => {
  const port = nextPort();
  const a = new Server({ reusePort: true });
  a.get('/', (c) => c.text('a'));
  await a.listen({ port, host: '127.0.0.1' });

  const b = new Server({ reusePort: true });
  b.get('/', (c) => c.text('b'));
  try {
    // Without SO_REUSEPORT this would be EADDRINUSE.
    await b.listen({ port, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await res.text(), /^[ab]$/, 'one of the two serves the request');
  } finally {
    await a.close();
    await b.close();
  }
});

test('M10c: backlog/noDelay/workerThreads are accepted and the server works', async () => {
  const s = await up({
    config: { backlog: 64, noDelay: false, workerThreads: 2 },
    routes: (app) => app.get('/', (c) => c.text('tuned')),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(await res.text(), 'tuned');
  } finally {
    await s.close();
  }
});

test("M10c: workerThreads:'auto' is valid, garbage throws TypeError", async () => {
  const s = await up({
    config: { workerThreads: 'auto' },
    routes: (app) => app.get('/', (c) => c.text('auto')),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(await res.text(), 'auto');
  } finally {
    await s.close();
  }
  // @ts-expect-error — deliberately invalid value: we check the runtime validation
  assert.throws(() => new Server({ workerThreads: 'many' }), TypeError);
});
