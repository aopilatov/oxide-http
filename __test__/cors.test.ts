import test from 'node:test';
import assert from 'node:assert/strict';

import { Server } from '../js/index.ts';

let PORT = 20600;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('M6: CORS preflight отвечается в Rust, НЕ будя JS', async () => {
  let jsWoken = false;
  const s = await up({
    config: { cors: { origin: '*' } },
    routes: (app) =>
      app.options('/x', () => {
        jsWoken = true; // не должно вызваться на preflight
        return 'js';
      }),
  });
  try {
    const res = await fetch(`${s.base}/x`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin')!, '*');
    assert.ok(res.headers.get('access-control-allow-methods')!.includes('POST'));
    // allowedHeaders не задан → отражаем запрошенные
    assert.equal(res.headers.get('access-control-allow-headers')!, 'content-type, authorization');
    assert.equal(jsWoken, false, 'JS не должен просыпаться на preflight');
  } finally {
    s.close();
  }
});

test('M6: запрещённый origin отклонён (403) на preflight', async () => {
  const s = await up({
    config: { cors: { origin: ['https://ok.com'] } },
    routes: (app) => app.post('/x', (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/x`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin')!, null);
  } finally {
    s.close();
  }
});

test('M6: CORS-заголовки на обычном ответе (allowed origin)', async () => {
  const s = await up({
    config: { cors: { origin: ['https://ok.com'], credentials: true, exposedHeaders: ['x-total'] } },
    routes: (app) => app.get('/data', (c) => c.json({ ok: true })),
  });
  try {
    const res = await fetch(`${s.base}/data`, { headers: { origin: 'https://ok.com' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin')!, 'https://ok.com');
    assert.equal(res.headers.get('access-control-allow-credentials')!, 'true');
    assert.equal(res.headers.get('access-control-expose-headers')!, 'x-total');
    assert.equal(res.headers.get('vary')!, 'origin');
  } finally {
    s.close();
  }
});

test('M6: обычный запрос с чужого origin — без ACAO, но обрабатывается', async () => {
  const s = await up({
    config: { cors: { origin: ['https://ok.com'] } },
    routes: (app) => app.get('/data', (c) => c.text('served')),
  });
  try {
    const res = await fetch(`${s.base}/data`, { headers: { origin: 'https://evil.com' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'served'); // сервер отвечает
    assert.equal(res.headers.get('access-control-allow-origin')!, null); // но без ACAO
  } finally {
    s.close();
  }
});

test('M6: credentials + origin=* → ACAO отражает конкретный origin (не *)', async () => {
  const s = await up({
    config: { cors: { origin: '*', credentials: true } },
    routes: (app) => app.get('/d', (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/d`, { headers: { origin: 'https://x.com' } });
    assert.equal(res.headers.get('access-control-allow-origin')!, 'https://x.com');
    assert.equal(res.headers.get('access-control-allow-credentials')!, 'true');
  } finally {
    s.close();
  }
});

test('M6: preflight с maxAge', async () => {
  const s = await up({
    config: { cors: { origin: '*', maxAge: 3600 } },
    routes: (app) => app.post('/x', (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/x`, {
      method: 'OPTIONS',
      headers: { origin: 'https://a.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.headers.get('access-control-max-age')!, '3600');
  } finally {
    s.close();
  }
});

test('M6: без cors-конфига CORS-заголовков нет', async () => {
  const s = await up({
    routes: (app) => app.get('/x', (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/x`, { headers: { origin: 'https://a.com' } });
    assert.equal(res.headers.get('access-control-allow-origin')!, null);
  } finally {
    s.close();
  }
});

test('M6: body-limit нативный (подтверждение) — 413 без cors', async () => {
  const s = await up({
    config: { bodyLimit: '1kb' },
    routes: (app) => app.post('/u', async (c) => c.text(await c.req.text())),
  });
  try {
    const res = await fetch(`${s.base}/u`, { method: 'POST', body: 'z'.repeat(5000) });
    assert.equal(res.status, 413);
  } finally {
    s.close();
  }
});
