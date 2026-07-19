import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { Server } = require('../js/index.js');

const here = dirname(fileURLToPath(import.meta.url));
const CERT = readFileSync(join(here, 'fixtures/cert.pem'), 'utf8');
const KEY = readFileSync(join(here, 'fixtures/key.pem'), 'utf8');

let PORT = 38900;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, close: () => server.close() };
}

/** HTTP/2 клиент (TLS или h2c) → один GET. */
function h2get(url, opts = {}) {
  return new Promise((resolve, reject) => {
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
    const body = await new Promise((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port: s.port, path: '/', ca: CERT, ALPNProtocols: ['http/1.1'] },
        (res) => {
          assert.equal(res.alpnProtocol, 'http/1.1');
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(d));
        },
      );
      req.on('error', reject);
      req.end();
    });
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

test('M9: cert из Buffer грузится', async () => {
  const s = await up({
    config: { tls: { cert: Buffer.from(CERT), key: Buffer.from(KEY) } },
    routes: (app) => app.get('/', (c) => c.text('buf-ok')),
  });
  try {
    const body = await new Promise((resolve, reject) => {
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

test('M9: Slowloris — медленные заголовки отсекаются таймаутом', async () => {
  const s = await up({
    config: { headerReadTimeout: '200ms' },
    routes: (app) => app.get('/', (c) => c.text('ok')),
  });
  try {
    const closed = await new Promise((resolve) => {
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
        // Шлём начало запроса и НЕ завершаем заголовки.
        socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
        // не пишем финальный \r\n — сервер должен закрыть по таймауту
      });
      socket.on('close', () => finish('closed'));
      socket.on('end', () => finish('closed'));
      setTimeout(() => finish('still-open'), 1500);
    });
    assert.equal(closed, 'closed', 'соединение должно закрыться по headerReadTimeout');
  } finally {
    s.close();
  }
});

test('M9: HTTP/2 с настройками (maxConcurrentStreams, initialWindowSize)', async () => {
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
