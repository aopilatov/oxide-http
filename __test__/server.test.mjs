import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Server } = require('../js/index.js');

// Фиксированные порты (автовыбор listen({port:0}) — на M10).
let PORT = 38100;
const nextPort = () => PORT++;

/** Поднять сервер на свободном порту, вернуть { base, close }. */
async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('M1-regression: сквозной путь и async-хендлер', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/hello', async (c) => {
        await new Promise((r) => setImmediate(r));
        return { status: 201, headers: { 'x-p': c.req.path }, body: 'hi' };
      }),
  });
  try {
    const res = await fetch(`${s.base}/hello`);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('x-p'), '/hello');
    assert.equal(await res.text(), 'hi');
  } finally {
    s.close();
  }
});

test('M2: :param и приоритет static над param', async () => {
  const s = await up({
    routes: (app) =>
      app
        .get('/users/me', () => ({ body: 'me' }))
        .get('/users/:id', (c) => ({ body: `id=${c.req.params.id}` })),
  });
  try {
    assert.equal(await (await fetch(`${s.base}/users/me`)).text(), 'me');
    assert.equal(await (await fetch(`${s.base}/users/42`)).text(), 'id=42');
  } finally {
    s.close();
  }
});

test('M2: catch-all', async () => {
  const s = await up({
    routes: (app) => app.get('/static/*path', (c) => ({ body: c.req.params.path })),
  });
  try {
    assert.equal(await (await fetch(`${s.base}/static/css/app.css`)).text(), 'css/app.css');
  } finally {
    s.close();
  }
});

test('M2: query — last-wins + queries()', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/q', (c) => ({
        body: JSON.stringify({ last: c.req.query.k, all: c.req.queries('k') }),
      })),
  });
  try {
    const res = await fetch(`${s.base}/q?k=a&k=b&x=1`);
    assert.deepEqual(await res.json(), { last: 'b', all: ['a', 'b'] });
  } finally {
    s.close();
  }
});

test('M2: 404 (Rust) и 405 + Allow (Rust)', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/users', () => ({ body: 'g' })).post('/users', () => ({ body: 'p' })),
  });
  try {
    assert.equal((await fetch(`${s.base}/nope`)).status, 404);
    const res = await fetch(`${s.base}/users`, { method: 'DELETE' });
    assert.equal(res.status, 405);
    const allow = res.headers.get('allow');
    assert.ok(allow.includes('GET') && allow.includes('POST') && allow.includes('HEAD'));
  } finally {
    s.close();
  }
});

test('M2: авто-HEAD (как GET без тела) и авто-OPTIONS', async () => {
  const s = await up({
    routes: (app) => app.get('/x', () => ({ headers: { 'x-h': '1' }, body: 'hello' })),
  });
  try {
    const head = await fetch(`${s.base}/x`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('x-h'), '1');
    assert.equal(head.headers.get('content-length'), '5');
    assert.equal(await head.text(), ''); // тела нет

    const opt = await fetch(`${s.base}/x`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    assert.ok(opt.headers.get('allow').includes('GET'));
  } finally {
    s.close();
  }
});

test('M2: baseUrl склеивается при регистрации', async () => {
  const s = await up({
    config: { baseUrl: '/api/v1' },
    routes: (app) => app.get('/users/:id', (c) => ({ body: c.req.params.id })),
  });
  try {
    assert.equal(await (await fetch(`${s.base}/api/v1/users/7`)).text(), '7');
    assert.equal((await fetch(`${s.base}/users/7`)).status, 404); // без префикса — 404
  } finally {
    s.close();
  }
});

test('M2: группы app.route(prefix, sub)', async () => {
  const sub = new Server();
  sub.get('/ping', () => ({ body: 'pong' }));

  const s = await up({
    routes: (app) => {
      app.get('/', () => ({ body: 'root' }));
      app.route('/admin', sub);
    },
  });
  try {
    assert.equal(await (await fetch(`${s.base}/`)).text(), 'root');
    assert.equal(await (await fetch(`${s.base}/admin/ping`)).text(), 'pong');
  } finally {
    s.close();
  }
});

test('M2: app.all(), notFound() и close() идемпотентен', async () => {
  const s = await up({
    routes: (app) => {
      app.all('/any', (c) => ({ body: c.req.method }));
      app.notFound((c) => ({ status: 404, body: `no ${c.req.path}` }));
    },
  });
  try {
    assert.equal(await (await fetch(`${s.base}/any`, { method: 'PUT' })).text(), 'PUT');
    const nf = await fetch(`${s.base}/missing`);
    assert.equal(nf.status, 404);
    assert.equal(await nf.text(), 'no /missing');
  } finally {
    s.close();
    s.close(); // идемпотентно
  }
});
