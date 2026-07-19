import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';

import { Server } from '../js/index.ts';

test('M12: inject without listen — starts on its own, no socket needed', async () => {
  const app = new Server();
  app.get('/hello', (c) => c.json({ hi: true }));
  try {
    const res = await app.inject({ path: '/hello' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json<any>(), { hi: true });
  } finally {
    await app.close();
  }
});

test('M12: inject carries params, query and headers', async () => {
  const app = new Server();
  app.get('/u/:id', (c) =>
    c.json({
      id: c.req.params.id,
      q: c.req.query.sort,
      ua: c.req.header('user-agent'),
    }),
  );
  try {
    const res = await app.inject({
      path: '/u/42',
      query: { sort: 'desc' },
      headers: { 'user-agent': 'inject-test' },
    });
    assert.deepEqual(res.json<any>(), { id: '42', q: 'desc', ua: 'inject-test' });
  } finally {
    await app.close();
  }
});

test('M12: inject with a body — the object is serialized to JSON', async () => {
  const app = new Server();
  app.post('/echo', async (c) => c.json(await c.req.json()));
  try {
    const res = await app.inject({ method: 'POST', path: '/echo', body: { a: 1, b: 'two' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json<any>(), { a: 1, b: 'two' });
  } finally {
    await app.close();
  }
});

test('M12: inject sees 404 and 405 from Rust', async () => {
  const app = new Server();
  app.get('/only-get', (c) => c.text('ok'));
  try {
    assert.equal((await app.inject({ path: '/no-such-route' })).status, 404);
    const notAllowed = await app.inject({ method: 'DELETE', path: '/only-get' });
    assert.equal(notAllowed.status, 405);
    assert.match(notAllowed.headers.allow!, /GET/);
  } finally {
    await app.close();
  }
});

test('M12: inject goes through middleware, hooks and onError', async () => {
  const app = new Server();
  const order: any[] = [];
  app.use(async (c, next) => {
    order.push('mw-in');
    try {
      await next();
      order.push('mw-out');
    } catch (e) {
      // The onion tail after a throw does not run by itself — that is the usual
      // semantics: middleware must catch the error explicitly to continue.
      order.push('mw-caught');
      throw e;
    }
  });
  app.onRequest(() => void order.push('onRequest'));
  app.get('/boom', () => {
    throw new Error('handler blew up');
  });
  app.onError((err: any, c) => c.json({ handled: err.message }, 500));
  try {
    const res = await app.inject({ path: '/boom' });
    assert.equal(res.status, 500);
    assert.deepEqual(res.json<any>(), { handled: 'handler blew up' });
    assert.deepEqual(order, ['onRequest', 'mw-in', 'mw-caught']);
  } finally {
    await app.close();
  }
});

test('M12: inject goes through native schema validation', async () => {
  const app = new Server();
  app.post('/users', { schema: { body: v.object({ name: v.string(), age: v.number() }) } }, (c) =>
    c.json({ ok: c.req.valid('body') }),
  );
  try {
    const bad = await app.inject({ method: 'POST', path: '/users', body: { name: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json<any>().error, 'validation');

    const good = await app.inject({
      method: 'POST',
      path: '/users',
      body: { name: 'Anna', age: 30 },
    });
    assert.equal(good.status, 200);
    assert.deepEqual(good.json<any>(), { ok: { name: 'Anna', age: 30 } });
  } finally {
    await app.close();
  }
});

test('M12: inject returns multiple Set-Cookie values as separate lines', async () => {
  const app = new Server();
  app.get('/cookies', (c) => {
    c.cookie('a', '1');
    c.cookie('b', '2');
    return c.text('ok');
  });
  try {
    const res = await app.inject({ path: '/cookies' });
    const cookies = res.rawHeaders.filter((h) => h.key.toLowerCase() === 'set-cookie');
    assert.equal(cookies.length, 2, 'set-cookie must not be collapsed');
    assert.match(cookies[0]!.value, /^a=1/);
    assert.match(cookies[1]!.value, /^b=2/);
  } finally {
    await app.close();
  }
});

test('M12: inject works with a streamed response and a binary body', async () => {
  const app = new Server();
  app.get('/stream', (c) =>
    c.body(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('part-1|'));
          ctrl.enqueue(new TextEncoder().encode('part-2'));
          ctrl.close();
        },
      }),
    ),
  );
  app.get('/binary', (c) => c.body(Buffer.from([0x00, 0xff, 0x10])));
  try {
    assert.equal((await app.inject({ path: '/stream' })).text(), 'part-1|part-2');
    const bin = await app.inject({ path: '/binary' });
    assert.deepEqual([...bin.body], [0x00, 0xff, 0x10]);
  } finally {
    await app.close();
  }
});

test('M12: inject is counted in metrics like a regular request', async () => {
  const app = new Server();
  app.get('/counted', (c) => c.text('ok'));
  try {
    await app.inject({ path: '/counted' });
    await app.inject({ path: '/counted' });
    const metrics = await app.inject({ path: '/metrics' });
    assert.match(metrics.text(), /http_requests_total\{method="GET",status="2xx"\} \d+/);
  } finally {
    await app.close();
  }
});

test('M12: inject after close() does not silently resurrect the server', async () => {
  const app = new Server();
  app.get('/', (c) => c.text('ok'));
  await app.inject({ path: '/' });
  await app.close();
  // Auto-start only applies to a server that was never started: silently grabbing a new
  // port after an explicit close() would be surprising.
  await assert.rejects(() => app.inject({ path: '/' }), /server is closed/);
});

test('M12: inject rejects a header HTTP cannot carry', async () => {
  const app = new Server();
  app.get('/h', (c) => c.json({ got: c.req.header('authorization') ?? null }));
  try {
    // A real fetch answers with a ByteString error here — the harness must do the same,
    // otherwise the test would be green where the network refuses.
    await assert.rejects(
      () => app.inject({ path: '/h', headers: { authorization: 'Bearer 🔑-token' } }),
      /outside the byte range/,
    );
    // An ASCII value passes as usual.
    const ok = await app.inject({ path: '/h', headers: { authorization: 'Bearer secret' } });
    assert.equal(ok.json<{ got: string }>().got, 'Bearer secret');
  } finally {
    await app.close();
  }
});
