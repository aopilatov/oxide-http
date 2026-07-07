import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { Server } = require('../js/index.js');

let PORT = 38300;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('M4: c.req.json() читает тело', async () => {
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

test('M4: c.req.text() и c.req.parseBody() (urlencoded)', async () => {
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

test('M4: большой upload читается стримом (c.req.stream), без буфера всего', async () => {
  const CHUNKS = 200;
  const CHUNK = 'x'.repeat(64 * 1024); // 64KB * 200 = 12.8MB > дефолт? нет, лимит 10mb
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

test('M4: 413 при превышении bodyLimit', async () => {
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

test('M4: входящая декомпрессия gzip (лимит по распакованному)', async () => {
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

test('M4: стриминг ответа (SSE-подобный) идёт чанками', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/sse', (c) => {
        c.header('content-type', 'text/event-stream');
        const stream = new ReadableStream({
          async start(controller) {
            for (let i = 0; i < 3; i++) {
              controller.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
              await new Promise((r) => setTimeout(r, 5));
            }
            controller.close();
          },
        });
        return c.body(stream);
      }),
  });
  try {
    const res = await fetch(`${s.base}/sse`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(await res.text(), 'data: 0\n\ndata: 1\n\ndata: 2\n\n');
  } finally {
    s.close();
  }
});

test('M4: c.body(Buffer) — бинарный ответ через стрим', async () => {
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

test('M4: backpressure ответа — producer тормозит под медленного потребителя', async () => {
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
    const reader = res.body.getReader();
    // Читаем только первый чанк и ждём — producer не должен убежать далеко вперёд.
    await reader.read();
    await new Promise((r) => setTimeout(r, 50));
    const producedEarly = produced;
    // Дочитываем.
    while (!(await reader.read()).done);
    assert.ok(
      producedEarly < 100,
      `producer убежал вперёд (${producedEarly}/100) — backpressure не работает`,
    );
  } finally {
    s.close();
  }
});
