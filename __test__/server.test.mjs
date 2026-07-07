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

test('M2: :param и приоритет static над param', async () => {
  const s = await up({
    routes: (app) =>
      app
        .get('/users/me', (c) => c.text('me'))
        .get('/users/:id', (c) => c.text(`id=${c.req.params.id}`)),
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
    routes: (app) => app.get('/static/*path', (c) => c.text(c.req.params.path)),
  });
  try {
    assert.equal(await (await fetch(`${s.base}/static/css/app.css`)).text(), 'css/app.css');
  } finally {
    s.close();
  }
});

test('M2: query — last-wins + queries()', async () => {
  const s = await up({
    routes: (app) => app.get('/q', (c) => c.json({ last: c.req.query.k, all: c.req.queries('k') })),
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
    routes: (app) => app.get('/users', (c) => c.text('g')).post('/users', (c) => c.text('p')),
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

test('M2: авто-HEAD и авто-OPTIONS', async () => {
  const s = await up({
    routes: (app) => app.get('/x', (c) => c.body('hello', 200)),
  });
  try {
    const head = await fetch(`${s.base}/x`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '5');
    assert.equal(await head.text(), '');

    const opt = await fetch(`${s.base}/x`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    assert.ok(opt.headers.get('allow').includes('GET'));
  } finally {
    s.close();
  }
});

test('M2: baseUrl, группы, all(), notFound()', async () => {
  const sub = new Server();
  sub.get('/ping', (c) => c.text('pong'));

  const s = await up({
    config: { baseUrl: '/api/v1' },
    routes: (app) => {
      app.get('/users/:id', (c) => c.text(c.req.params.id));
      app.all('/any', (c) => c.text(c.req.method));
      app.route('/admin', sub);
      app.notFound((c) => c.text(`no ${c.req.path}`, 404));
    },
  });
  try {
    assert.equal(await (await fetch(`${s.base}/api/v1/users/7`)).text(), '7');
    assert.equal(await (await fetch(`${s.base}/api/v1/any`, { method: 'PUT' })).text(), 'PUT');
    assert.equal(await (await fetch(`${s.base}/api/v1/admin/ping`)).text(), 'pong');
    const nf = await fetch(`${s.base}/api/v1/missing`);
    assert.equal(nf.status, 404);
  } finally {
    s.close();
  }
});

// --- M3 ---

test('M3: c.json ставит статус и content-type', async () => {
  const s = await up({
    routes: (app) => app.get('/j', (c) => c.json({ ok: true }, 201)),
  });
  try {
    const res = await fetch(`${s.base}/j`);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    s.close();
  }
});

test('M3: возврат значения как сахар (object→json, string→text)', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/obj', () => ({ a: 1 })).get('/str', () => 'plain'),
  });
  try {
    const o = await fetch(`${s.base}/obj`);
    assert.equal(o.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await o.json(), { a: 1 });
    const t = await fetch(`${s.base}/str`);
    assert.equal(t.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await t.text(), 'plain');
  } finally {
    s.close();
  }
});

test('M3: заголовки запроса регистронезависимы', async () => {
  const s = await up({
    routes: (app) => app.get('/h', (c) => c.text(c.req.header('X-Custom') ?? 'none')),
  });
  try {
    const res = await fetch(`${s.base}/h`, { headers: { 'x-custom': 'yes' } });
    assert.equal(await res.text(), 'yes');
  } finally {
    s.close();
  }
});

test('M3: Set-Cookie отдельными строками + c.req.cookie', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/c', (c) => {
        c.cookie('a', '1', { httpOnly: true });
        c.cookie('b', '2', { path: '/x', sameSite: 'lax' });
        return c.text(`in=${c.req.cookie('sid')}`);
      }),
  });
  try {
    const res = await fetch(`${s.base}/c`, { headers: { cookie: 'sid=xyz; other=1' } });
    assert.equal(await res.text(), 'in=xyz');
    const setCookie = res.headers.getSetCookie();
    assert.equal(setCookie.length, 2);
    assert.ok(setCookie[0].startsWith('a=1'));
    assert.ok(setCookie[0].includes('HttpOnly'));
    assert.ok(setCookie[1].includes('SameSite=Lax'));
  } finally {
    s.close();
  }
});

test('M3: ip/ips/country из custom-заголовков', async () => {
  const s = await up({
    config: {
      customIpHeaders: ['x-forwarded-for'],
      customCountryHeaders: ['x-country-code'],
    },
    routes: (app) =>
      app.get('/ip', (c) => c.json({ ip: c.req.ip, ips: c.req.ips, country: c.req.country })),
  });
  try {
    const res = await fetch(`${s.base}/ip`, {
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'x-country-code': 'de' },
    });
    assert.deepEqual(await res.json(), {
      ip: '1.1.1.1',
      ips: ['1.1.1.1', '2.2.2.2'],
      country: 'DE',
    });
  } finally {
    s.close();
  }
});

test('M3: ip fallback на peer, country undefined без заголовка', async () => {
  const s = await up({
    routes: (app) => app.get('/ip', (c) => c.json({ ip: c.req.ip, country: c.req.country ?? null })),
  });
  try {
    const body = await (await fetch(`${s.base}/ip`)).json();
    assert.equal(body.ip, '127.0.0.1'); // peer
    assert.equal(body.country, null);
  } finally {
    s.close();
  }
});

test('M3: request-id генерируется (UUIDv7) и уходит в ответ', async () => {
  let seen;
  const s = await up({
    routes: (app) =>
      app.get('/id', (c) => {
        seen = c.req.id;
        return c.text('ok');
      }),
  });
  try {
    const res = await fetch(`${s.base}/id`);
    assert.match(seen, /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.get('x-request-id'), seen);

    // переданный x-request-id сохраняется
    const res2 = await fetch(`${s.base}/id`, { headers: { 'x-request-id': 'abc-123' } });
    assert.equal(seen, 'abc-123');
    assert.equal(res2.headers.get('x-request-id'), 'abc-123');
  } finally {
    s.close();
  }
});

test('M3: c.set/get, c.status/header, c.req.path без baseUrl', async () => {
  const s = await up({
    config: { baseUrl: '/api' },
    routes: (app) =>
      app.get('/p/:id', (c) => {
        c.set('uid', c.req.params.id);
        c.status(202).header('x-mark', 'm');
        return c.json({ path: c.req.path, rawPath: c.req.rawPath, uid: c.get('uid') });
      }),
  });
  try {
    const res = await fetch(`${s.base}/api/p/9`);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('x-mark'), 'm');
    assert.deepEqual(await res.json(), { path: '/p/9', rawPath: '/api/p/9', uid: '9' });
  } finally {
    s.close();
  }
});
