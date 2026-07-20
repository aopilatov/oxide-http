import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { gzipSync } from 'node:zlib';

import { Server } from '../js/index.ts';

let PORT = 20300;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, port, close: () => server.close() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('M4: c.req.json() reads the body', async () => {
  const s = await up({
    routes: (app) => app.post('/echo', async (c) => c.json(await c.req.json())),
  });
  try {
    const res = await fetch(`${s.base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, b: [2, 3] }),
    });
    assert.deepEqual(await res.json(), { a: 1, b: [2, 3] });
  } finally {
    s.close();
  }
});

test('M4: c.req.text() and c.req.parseBody() (urlencoded)', async () => {
  const s = await up({
    routes: (app) => {
      app.post('/t', async (c) => c.text(await c.req.text()));
      app.post('/f', async (c) => c.json(await c.req.parseBody()));
    },
  });
  try {
    assert.equal(await (await fetch(`${s.base}/t`, { method: 'POST', body: 'hi' })).text(), 'hi');
    const f = await fetch(`${s.base}/f`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'x=1&y=two',
    });
    assert.deepEqual(await f.json(), { x: '1', y: 'two' });
  } finally {
    s.close();
  }
});

test('M4: a large upload is read as a stream (c.req.stream), without buffering it all', async () => {
  const CHUNKS = 200;
  const CHUNK = 'x'.repeat(64 * 1024); // 64KB * 200 = 12.8MB; the limit is 10mb
  let counted = 0;
  const s = await up({
    config: { bodyLimit: '64mb' },
    routes: (app) =>
      app.post('/up', async (c) => {
        for await (const chunk of c.req.stream) counted += chunk.length;
        return c.json({ bytes: counted });
      }),
  });
  try {
    const body = CHUNK.repeat(CHUNKS);
    const res = await fetch(`${s.base}/up`, { method: 'POST', body });
    assert.deepEqual(await res.json(), { bytes: CHUNKS * CHUNK.length });
  } finally {
    s.close();
  }
});

test('M4: 413 when bodyLimit is exceeded', async () => {
  const s = await up({
    config: { bodyLimit: '1kb' },
    routes: (app) => app.post('/small', async (c) => c.text(await c.req.text())),
  });
  try {
    const res = await fetch(`${s.base}/small`, { method: 'POST', body: 'z'.repeat(5000) });
    assert.equal(res.status, 413);
  } finally {
    s.close();
  }
});

test('A2: a body cut short raises an error instead of looking complete', async () => {
  // The regression this guards: a read error mid-body used to be indistinguishable from
  // a clean EOF, so the handler received half an upload and believed it was the whole
  // thing. The client is gone by then, so we assert on what the handler saw.
  const seen: { text?: string; error?: string } = {};
  const s = await up({
    routes: (app) =>
      app.post('/sink', async (c) => {
        try {
          seen.text = await c.req.text();
        } catch (e) {
          seen.error = e instanceof Error ? e.message : String(e);
        }
        return c.text('ok');
      }),
  });
  try {
    const sock = net.connect(s.port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    // Announce 100 bytes, deliver 5, then kill the connection.
    sock.write('POST /sink HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nhello');
    await sleep(80);
    sock.destroy();
    await sleep(400);

    assert.equal(seen.text, undefined, 'a truncated body must never read as complete');
    assert.match(seen.error ?? '', /abort/i, `unexpected error: ${seen.error}`);
  } finally {
    s.close();
  }
});

test('M4: inbound gzip decompression (limit applies to the decompressed size)', async () => {
  const s = await up({
    routes: (app) => app.post('/gz', async (c) => c.text(await c.req.text())),
  });
  try {
    const payload = 'compressed payload '.repeat(100);
    const res = await fetch(`${s.base}/gz`, {
      method: 'POST',
      headers: { 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from(payload)),
    });
    assert.equal(await res.text(), payload);
  } finally {
    s.close();
  }
});

test('M4: response streaming (SSE-like) arrives in chunks', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/sse', (c) => {
        c.header('content-type', 'text/event-stream');
        const stream = new ReadableStream({
          async start(controller) {
            for (let i = 0; i < 3; i++) {
              controller.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
              await new Promise<void>((r) => setTimeout(r, 5));
            }
            controller.close();
          },
        });
        return c.body(stream);
      }),
  });
  try {
    const res = await fetch(`${s.base}/sse`);
    assert.equal(res.headers.get('content-type')!, 'text/event-stream');
    assert.equal(await res.text(), 'data: 0\n\ndata: 1\n\ndata: 2\n\n');
  } finally {
    s.close();
  }
});

test('M4: c.body(Buffer) — a binary response through the stream', async () => {
  const s = await up({
    routes: (app) => app.get('/bin', (c) => c.body(Buffer.from([1, 2, 3, 250, 251]))),
  });
  try {
    const res = await fetch(`${s.base}/bin`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf], [1, 2, 3, 250, 251]);
  } finally {
    s.close();
  }
});

test('M4: response backpressure — the producer slows down for a slow consumer', async () => {
  let produced = 0;
  const s = await up({
    routes: (app) =>
      app.get('/bp', (c) => {
        const stream = new ReadableStream({
          async pull(controller) {
            produced++;
            controller.enqueue(new Uint8Array(256 * 1024)); // 256KB
            if (produced >= 100) controller.close();
          },
        });
        return c.body(stream);
      }),
  });
  try {
    const res = await fetch(`${s.base}/bp`);
    const reader = res.body!.getReader();
    // Read only the first chunk and wait — the producer must not run far ahead.
    await reader.read();
    await new Promise<void>((r) => setTimeout(r, 50));
    const producedEarly = produced;
    // Drain the rest.
    while (!(await reader.read()).done);
    assert.ok(
      producedEarly < 100,
      `producer ran ahead (${producedEarly}/100) — backpressure is not working`,
    );
  } finally {
    s.close();
  }
});
