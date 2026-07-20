import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { Server } from '../js/index.ts';

let PORT = 20400;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Raw HTTP request over TCP (fetch will not send malformed bodies). */
function rawRequest(
  port: number,
  requestText: string,
  { bodyChunks = [], settleMs = 300 }: { bodyChunks?: string[]; settleMs?: number } = {},
) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => (data += d));
    // The connection may be reset (garbage after the body / Connection: close) — that is
    // not a test failure: the response to the first request already arrived. Ignore it.
    socket.on('error', () => {});
    socket.on('connect', async () => {
      socket.write(requestText);
      for (const ch of bodyChunks) {
        socket.write(ch);
        await new Promise<void>((r) => setTimeout(r, 10));
      }
    });
    setTimeout(() => {
      socket.destroy();
      const statusLine = data.split('\r\n')[0] || '';
      const m = statusLine.match(/HTTP\/1\.[01] (\d{3})/);
      resolve({ status: m ? Number(m[1]) : 0, raw: data });
    }, settleMs);
  });
}

test('SECURITY: the limit holds on the RAW stream (the handler does not check the size)', async () => {
  // The handler just drains c.req.stream WITHOUT checking the size itself — the limit
  // must fire in Rust, otherwise it is a DoS. bodyLimit 1kb, we send ~10kb.
  let received = 0;
  const s = await up({
    config: { bodyLimit: '1kb' },
    routes: (app) =>
      app.post('/raw', async (c) => {
        for await (const chunk of c.req.stream) received += chunk.length;
        return c.text('ok');
      }),
  });
  try {
    const res = await fetch(`${s.base}/raw`, { method: 'POST', body: 'A'.repeat(10 * 1024) });
    assert.equal(res.status, 413, 'the raw stream must hit the limit');
    assert.ok(received <= 1024 + 65536, `Rust read too much: ${received} bytes`);
  } finally {
    s.close();
  }
});

test('SECURITY: the limit holds on chunked WITHOUT Content-Length', async () => {
  // Transfer-Encoding: chunked — there is no Content-Length at all. The limit must count
  // actual bytes. We send many small chunks over a raw socket.
  const s = await up({
    config: { bodyLimit: '2kb' },
    routes: (app) => app.post('/chunked', async (c) => c.text(await c.req.text())),
  });
  try {
    // 20 chunks of 512 bytes = 10kb > 2kb.
    const chunks = [] as any[];
    for (let i = 0; i < 20; i++) {
      chunks.push(`200\r\n${'B'.repeat(512)}\r\n`);
    }
    chunks.push('0\r\n\r\n');
    const req =
      `POST /chunked HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`;
    const res = await rawRequest(s.port, req, { bodyChunks: chunks });
    assert.equal(res.status, 413, 'chunked without CL must hit the limit');
  } finally {
    s.close();
  }
});

test('SECURITY: early 413 from the declared Content-Length (the body is never read)', async () => {
  let handlerCalled = false;
  const s = await up({
    config: { bodyLimit: '1kb' },
    routes: (app) =>
      app.post('/big', async (c) => {
        handlerCalled = true;
        return c.text('ok');
      }),
  });
  try {
    // We declare a large Content-Length — the refusal must come immediately.
    const req =
      `POST /big HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n`;
    const res = await rawRequest(s.port, req, { settleMs: 200 });
    assert.equal(res.status, 413);
    assert.equal(handlerCalled, false, 'the handler must not run on an early 413');
  } finally {
    s.close();
  }
});

test('SECURITY: Content-Length understates — hyper frames by CL, the excess never enters the body', async () => {
  // We declare CL=5 and send more. hyper yields exactly 5 bytes; the tail becomes the
  // next (pipelined) request, not part of the body. The limit cannot be bypassed.
  const s = await up({
    config: { bodyLimit: '1mb' },
    routes: (app) => app.post('/cl', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const req =
      `POST /cl HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHELLO` +
      'X'.repeat(10000); // extra bytes after the body
    const res = await rawRequest(s.port, req, { settleMs: 200 });
    assert.equal(res.status, 200);
    assert.match(res.raw, /"len":5/, 'the body must be exactly 5 bytes (CL), with no extra mixed in');
  } finally {
    s.close();
  }
});

test('SECURITY: without a limit (bodyLimit unset) a large body is still read', async () => {
  // Sanity: when no low limit is set it behaves normally (10mb default).
  const s = await up({
    routes: (app) => app.post('/ok', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const res = await fetch(`${s.base}/ok`, { method: 'POST', body: 'y'.repeat(100 * 1024) });
    assert.deepEqual(await res.json(), { len: 100 * 1024 });
  } finally {
    s.close();
  }
});

test('D1: bodyLimit: null removes the limit, omitting it keeps the default', async () => {
  // There was no way to reach the native "no limit" state: `undefined` and "not set"
  // both fell back to the 10mb default.
  const over = 11 * 1024 * 1024; // over the 10mb default

  // Declared-only body: the early 413 fires on Content-Length alone, so the client never
  // streams megabytes the server has already refused (which raced into EPIPE).
  const capped = await up({
    routes: (app) => app.post('/x', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const req =
      `POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: ${over}\r\nConnection: close\r\n\r\n`;
    const res = await rawRequest(capped.port, req, { settleMs: 200 });
    assert.equal(res.status, 413, 'the default limit still applies when unset');
  } finally {
    capped.close();
  }

  // With the limit off the same declaration is accepted and the body is read in full.
  const uncapped = await up({
    config: { bodyLimit: null },
    routes: (app) => app.post('/x', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const res = await fetch(`${uncapped.base}/x`, { method: 'POST', body: 'z'.repeat(over) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { len: over });
  } finally {
    uncapped.close();
  }
});

test('D8: a negative count option is a config error', () => {
  // These used to be filtered out in Rust with `n > 0`, so `maxConnections: -1` quietly
  // became "no limit" instead of failing.
  assert.throws(() => new Server({ maxConnections: -1 }), /maxConnections/);
  assert.throws(() => new Server({ maxHeaders: -5 }), /maxHeaders/);
  assert.throws(() => new Server({ maxConcurrentRequests: -2 }), /maxConcurrentRequests/);
  assert.throws(() => new Server({ maxQueue: 1.5 }), /maxQueue/);
  assert.doesNotThrow(() => new Server({ maxConnections: 0 }));
});

test('E2: an explicit bodyLimit: undefined keeps the default, only null disables', async () => {
  // `== null` matched undefined too, so spreading a config carrying an explicit
  // `bodyLimit: undefined` silently removed the limit — and the zip-bomb bound with it.
  const s = await up({
    config: { bodyLimit: undefined },
    routes: (app) => app.post('/x', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const req =
      `POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: ${11 * 1024 * 1024}\r\nConnection: close\r\n\r\n`;
    const res = await rawRequest(s.port, req, { settleMs: 200 });
    assert.equal(res.status, 413, 'undefined must fall back to the 10mb default');
  } finally {
    s.close();
  }
});
