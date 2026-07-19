import test from 'node:test';
import assert from 'node:assert/strict';

import { Server } from '../js/index.ts';

let PORT = 38800;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Собрать multipart/form-data вручную (fetch с FormData тоже можно, но так контролируем точнее). */
function multipart(parts) {
  const boundary = '----oxidetest' + Math.floor(performance.now());
  const chunks: any[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test('M8: потоковая загрузка — c.req.parts(), файлы и поля', async () => {
  const s = await up({
    routes: (app) =>
      app.post('/upload', { multipart: true }, async (c) => {
        const result: { files: unknown[]; fields: Record<string, unknown> } = { files: [], fields: {} };
        for await (const part of c.req.parts()) {
          if (part.filename) {
            let bytes = 0;
            for await (const chunk of part.stream) bytes += chunk.length;
            result.files.push({ name: part.name, filename: part.filename, bytes });
          } else {
            result.fields[part.name] = await part.text();
          }
        }
        return c.json(result);
      }),
  });
  try {
    const { body, contentType } = multipart([
      { name: 'title', data: 'My Photo' },
      { name: 'file', filename: 'pic.png', contentType: 'image/png', data: Buffer.alloc(1024, 7) },
    ]);
    const res = await fetch(`${s.base}/upload`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.deepEqual(await res.json(), {
      files: [{ name: 'file', filename: 'pic.png', bytes: 1024 }],
      fields: { title: 'My Photo' },
    });
  } finally {
    s.close();
  }
});

test('M8: большой файл стримится без буферизации всего в память', async () => {
  const s = await up({
    routes: (app) =>
      app.post('/big', { multipart: { maxFileSize: '20mb' } }, async (c) => {
        let total = 0;
        for await (const part of c.req.parts()) {
          if (part.filename) for await (const chunk of part.stream) total += chunk.length;
        }
        return c.json({ total });
      }),
  });
  try {
    const big = Buffer.alloc(8 * 1024 * 1024, 3); // 8MB
    const { body, contentType } = multipart([
      { name: 'f', filename: 'big.bin', contentType: 'application/octet-stream', data: big },
    ]);
    const res = await fetch(`${s.base}/big`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.deepEqual(await res.json(), { total: 8 * 1024 * 1024 });
  } finally {
    s.close();
  }
});

test('M8: maxFileSize превышен → 413', async () => {
  const s = await up({
    routes: (app) =>
      app.post('/u', { multipart: { maxFileSize: '1kb' } }, async (c) => {
        for await (const part of c.req.parts()) {
          if (part.filename) for await (const _ of part.stream);
        }
        return c.text('ok');
      }),
  });
  try {
    const { body, contentType } = multipart([
      { name: 'f', filename: 'big.bin', contentType: 'application/octet-stream', data: Buffer.alloc(5000) },
    ]);
    const res = await fetch(`${s.base}/u`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.equal(res.status, 413);
  } finally {
    s.close();
  }
});

test('M8: неверный MIME-тип → 415', async () => {
  const s = await up({
    routes: (app) =>
      app.post('/img', { multipart: { allowedMimeTypes: ['image/*'] } }, async (c) => {
        for await (const part of c.req.parts()) {
          if (part.filename) for await (const _ of part.stream);
        }
        return c.text('ok');
      }),
  });
  try {
    const { body, contentType } = multipart([
      { name: 'f', filename: 'evil.html', contentType: 'text/html', data: '<script>' },
    ]);
    const res = await fetch(`${s.base}/img`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.equal(res.status, 415);
  } finally {
    s.close();
  }
});

test('M8: неверное расширение → 415', async () => {
  const s = await up({
    routes: (app) =>
      app.post('/e', { multipart: { allowedExtensions: ['.png', '.jpg'] } }, async (c) => {
        for await (const part of c.req.parts()) {
          if (part.filename) for await (const _ of part.stream);
        }
        return c.text('ok');
      }),
  });
  try {
    const { body, contentType } = multipart([
      { name: 'f', filename: 'evil.exe', contentType: 'image/png', data: 'MZ' },
    ]);
    const res = await fetch(`${s.base}/e`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.equal(res.status, 415);
  } finally {
    s.close();
  }
});

test('M8: не multipart Content-Type при флаге → 415', async () => {
  const s = await up({
    routes: (app) => app.post('/u', { multipart: true }, (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/u`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 415);
  } finally {
    s.close();
  }
});

test('M8: c.req.formData() сахар', async () => {
  const s = await up({
    routes: (app) =>
      app.post('/f', { multipart: true }, async (c) => {
        const fd = await c.req.formData();
        const file = fd.get('doc');
        return c.json({ title: fd.get('title'), fileSize: file.size, fileName: file.name });
      }),
  });
  try {
    const { body, contentType } = multipart([
      { name: 'title', data: 'Hello' },
      { name: 'doc', filename: 'a.pdf', contentType: 'application/pdf', data: Buffer.alloc(256) },
    ]);
    const res = await fetch(`${s.base}/f`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    assert.deepEqual(await res.json(), { title: 'Hello', fileSize: 256, fileName: 'a.pdf' });
  } finally {
    s.close();
  }
});
