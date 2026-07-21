// Native response cache (§18): after the first response, identical requests are
// answered in Rust without waking JS. Opt-in per route: `cache: { ttl }`.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { Server } from '../js/index.ts';

let PORT = 22300;
const nextPort = () => PORT++;

async function up(build: {
  config?: ConstructorParameters<typeof Server>[0];
  routes?: (app: Server) => void;
}) {
  const server = new Server(build.config ?? {});
  build.routes?.(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

const get = async (port: number, path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.text(), headers: res.headers };
};

function queryRequest(
  port: number,
  path: string,
  body: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'QUERY',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('cache: a hit is served without waking JS and carries x-cache: hit', async () => {
  let calls = 0;
  const s = await up({
    routes: (app) =>
      app.get('/hot', { cache: '5s' }, (c) => {
        calls++;
        return c.json({ n: calls });
      }),
  });
  try {
    const first = await get(s.port, '/hot');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), null);

    const second = await get(s.port, '/hot');
    assert.equal(second.status, 200);
    assert.equal(second.body, first.body, 'the cached body must be identical');
    assert.equal(second.headers.get('x-cache'), 'hit');
    assert.equal(second.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(calls, 1, 'the handler must run exactly once');
  } finally {
    await s.close();
  }
});

test('cache: each request keeps its own x-request-id', async () => {
  const s = await up({
    routes: (app) => app.get('/rid', { cache: '5s' }, (c) => c.json({ ok: true })),
  });
  try {
    const a = await get(s.port, '/rid', { 'x-request-id': 'rid-a' });
    const b = await get(s.port, '/rid', { 'x-request-id': 'rid-b' });
    assert.equal(a.headers.get('x-request-id'), 'rid-a');
    assert.equal(b.headers.get('x-cache'), 'hit');
    assert.equal(b.headers.get('x-request-id'), 'rid-b', 'a hit must not replay the stored id');
  } finally {
    await s.close();
  }
});

test('cache: the TTL expires and the handler runs again', async () => {
  let calls = 0;
  const s = await up({
    routes: (app) =>
      app.get('/ttl', { cache: '150ms' }, (c) => {
        calls++;
        return c.json({ n: calls });
      }),
  });
  try {
    await get(s.port, '/ttl');
    await get(s.port, '/ttl');
    assert.equal(calls, 1);
    await sleep(200);
    const after = await get(s.port, '/ttl');
    assert.equal(calls, 2, 'an expired entry must re-run the handler');
    assert.deepEqual(JSON.parse(after.body), { n: 2 });
  } finally {
    await s.close();
  }
});

test('cache: the query string is part of the key', async () => {
  let calls = 0;
  const s = await up({
    routes: (app) =>
      app.get('/q', { cache: '5s' }, (c) => {
        calls++;
        return c.json({ v: c.req.query['v'] ?? null });
      }),
  });
  try {
    await get(s.port, '/q?v=1');
    await get(s.port, '/q?v=2');
    assert.equal(calls, 2, 'different query strings are different entries');
    const hit = await get(s.port, '/q?v=1');
    assert.equal(hit.headers.get('x-cache'), 'hit');
    assert.equal(calls, 2);
  } finally {
    await s.close();
  }
});

test('cache: vary separates entries by the configured header', async () => {
  let calls = 0;
  const s = await up({
    routes: (app) =>
      app.get('/t', { cache: { ttl: '5s', vary: ['x-tenant'] } }, (c) => {
        calls++;
        return c.json({ tenant: c.req.header('x-tenant') ?? null });
      }),
  });
  try {
    const a1 = await get(s.port, '/t', { 'x-tenant': 'a' });
    const b1 = await get(s.port, '/t', { 'x-tenant': 'b' });
    assert.equal(calls, 2);
    assert.notEqual(a1.body, b1.body);

    const a2 = await get(s.port, '/t', { 'x-tenant': 'a' });
    assert.equal(a2.headers.get('x-cache'), 'hit');
    assert.equal(a2.body, a1.body);
    assert.equal(calls, 2);
  } finally {
    await s.close();
  }
});

test('cache: QUERY is keyed by the body', async () => {
  let calls = 0;
  const s = await up({
    routes: (app) =>
      app.query('/search', { cache: '5s' }, async (c) => {
        calls++;
        const q = await c.req.json<{ term: string }>();
        return c.json({ term: q.term, call: calls });
      }),
  });
  try {
    const a1 = await queryRequest(s.port, '/search', JSON.stringify({ term: 'a' }));
    const b1 = await queryRequest(s.port, '/search', JSON.stringify({ term: 'b' }));
    assert.equal(calls, 2, 'different bodies are different entries');

    const a2 = await queryRequest(s.port, '/search', JSON.stringify({ term: 'a' }));
    assert.equal(a2.headers['x-cache'], 'hit');
    assert.equal(a2.body, a1.body);
    assert.equal(calls, 2, 'an identical body must hit');
    assert.notEqual(a2.body, b1.body);
  } finally {
    await s.close();
  }
});

test('cache: set-cookie and cache-control: no-store are never stored', async () => {
  let cookieCalls = 0;
  let noStoreCalls = 0;
  const s = await up({
    routes: (app) => {
      app.get('/cookie', { cache: '5s' }, (c) => {
        cookieCalls++;
        c.cookie('sid', String(cookieCalls));
        return c.json({ n: cookieCalls });
      });
      app.get('/no-store', { cache: '5s' }, (c) => {
        noStoreCalls++;
        c.header('cache-control', 'no-store');
        return c.json({ n: noStoreCalls });
      });
    },
  });
  try {
    await get(s.port, '/cookie');
    await get(s.port, '/cookie');
    assert.equal(cookieCalls, 2, 'a response with set-cookie must not be cached');

    await get(s.port, '/no-store');
    await get(s.port, '/no-store');
    assert.equal(noStoreCalls, 2, 'no-store must opt the response out');
  } finally {
    await s.close();
  }
});

test('cache: non-200 responses are not stored', async () => {
  let calls = 0;
  const s = await up({
    routes: (app) =>
      app.get('/maybe', { cache: '5s' }, (c) => {
        calls++;
        return calls === 1 ? c.text('nope', 404) : c.json({ ok: true });
      }),
  });
  try {
    const first = await get(s.port, '/maybe');
    assert.equal(first.status, 404);
    const second = await get(s.port, '/maybe');
    assert.equal(second.status, 200, 'the 404 must not have been cached');
    assert.equal(calls, 2);
  } finally {
    await s.close();
  }
});

test('cache: purgeCache(path) drops the entries, purgeCache() drops everything', async () => {
  let aCalls = 0;
  let bCalls = 0;
  const s = await up({
    routes: (app) => {
      app.get('/a', { cache: '30s' }, (c) => c.json({ n: ++aCalls }));
      app.get('/b', { cache: '30s' }, (c) => c.json({ n: ++bCalls }));
    },
  });
  try {
    await get(s.port, '/a');
    await get(s.port, '/b');
    assert.equal(s.server.purgeCache('/a'), 1);

    await get(s.port, '/a');
    await get(s.port, '/b');
    assert.equal(aCalls, 2, '/a was purged — the handler runs again');
    assert.equal(bCalls, 1, '/b stays cached');

    assert.equal(s.server.purgeCache(), 2);
    await get(s.port, '/a');
    await get(s.port, '/b');
    assert.equal(aCalls + bCalls, 5);
  } finally {
    await s.close();
  }
});

test('cache: auto-HEAD shares the GET entry and sends no body', async () => {
  let calls = 0;
  const s = await up({
    routes: (app) =>
      app.get('/h', { cache: '5s' }, (c) => {
        calls++;
        return c.json({ big: 'payload' });
      }),
  });
  try {
    await get(s.port, '/h');
    const head = await fetch(`http://127.0.0.1:${s.port}/h`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('x-cache'), 'hit');
    assert.equal(await head.text(), '');
    assert.equal(calls, 1);
  } finally {
    await s.close();
  }
});

test('cache: a hit runs no middleware and no hooks', async () => {
  let onionRuns = 0;
  let hookRuns = 0;
  const s = await up({
    routes: (app) => {
      app.use((_c, next) => (onionRuns++, next()));
      app.onRequest(() => void hookRuns++);
      app.get('/mw', { cache: '5s' }, (c) => c.json({ ok: true }));
    },
  });
  try {
    await get(s.port, '/mw');
    assert.equal(onionRuns, 1);
    await get(s.port, '/mw');
    assert.equal(onionRuns, 1, 'a hit must not wake the JS onion');
    assert.equal(hookRuns, 1, 'a hit must not run hooks');
  } finally {
    await s.close();
  }
});

test('cache: rejected on unsafe methods at registration', async () => {
  const app = new Server();
  assert.throws(
    () => app.post('/x', { cache: '5s' }, (c) => c.json({})),
    /cache is only supported/,
  );
  assert.throws(() => app.get('/x', { cache: '0s' }, (c) => c.json({})), /ttl must be > 0/);
});

test('cache: metrics expose hits and misses', async () => {
  const s = await up({
    config: { health: { metricsPath: '/metrics' } },
    routes: (app) => app.get('/m', { cache: '5s' }, (c) => c.json({ ok: true })),
  });
  try {
    await get(s.port, '/m');
    await get(s.port, '/m');
    const metrics = await get(s.port, '/metrics');
    assert.match(metrics.body, /http_cache_hits_total 1/);
    assert.match(metrics.body, /http_cache_misses_total 1/);
  } finally {
    await s.close();
  }
});
