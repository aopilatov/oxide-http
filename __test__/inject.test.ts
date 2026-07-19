import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from 'valibot';

import { Server } from '../js/index.ts';

test('M12: inject без listen — поднимается сам, сокет не нужен', async () => {
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

test('M12: inject прогоняет params, query и заголовки', async () => {
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

test('M12: inject с телом — объект сериализуется в JSON', async () => {
  const app = new Server();
  app.post('/echo', async (c) => c.json(await c.req.json()));
  try {
    const res = await app.inject({ method: 'POST', path: '/echo', body: { a: 1, b: 'два' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json<any>(), { a: 1, b: 'два' });
  } finally {
    await app.close();
  }
});

test('M12: inject видит 404 и 405 из Rust', async () => {
  const app = new Server();
  app.get('/only-get', (c) => c.text('ok'));
  try {
    assert.equal((await app.inject({ path: '/нет-такого' })).status, 404);
    const notAllowed = await app.inject({ method: 'DELETE', path: '/only-get' });
    assert.equal(notAllowed.status, 405);
    assert.match(notAllowed.headers.allow!, /GET/);
  } finally {
    await app.close();
  }
});

test('M12: inject проходит через middleware, хуки и onError', async () => {
  const app = new Server();
  const order: any[] = [];
  app.use(async (c, next) => {
    order.push('mw-in');
    try {
      await next();
      order.push('mw-out');
    } catch (e) {
      // Хвост луковицы после throw не выполняется сам собой — это обычная
      // семантика: middleware должен ловить ошибку явно, если хочет продолжить.
      order.push('mw-caught');
      throw e;
    }
  });
  app.onRequest(() => void order.push('onRequest'));
  app.get('/boom', () => {
    throw new Error('падение в хендлере');
  });
  app.onError((err: any, c) => c.json({ handled: err.message }, 500));
  try {
    const res = await app.inject({ path: '/boom' });
    assert.equal(res.status, 500);
    assert.deepEqual(res.json<any>(), { handled: 'падение в хендлере' });
    assert.deepEqual(order, ['onRequest', 'mw-in', 'mw-caught']);
  } finally {
    await app.close();
  }
});

test('M12: inject проходит нативную валидацию схемы', async () => {
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
      body: { name: 'Аня', age: 30 },
    });
    assert.equal(good.status, 200);
    assert.deepEqual(good.json<any>(), { ok: { name: 'Аня', age: 30 } });
  } finally {
    await app.close();
  }
});

test('M12: inject отдаёт несколько Set-Cookie отдельными строками', async () => {
  const app = new Server();
  app.get('/cookies', (c) => {
    c.cookie('a', '1');
    c.cookie('b', '2');
    return c.text('ok');
  });
  try {
    const res = await app.inject({ path: '/cookies' });
    const cookies = res.rawHeaders.filter((h) => h.key.toLowerCase() === 'set-cookie');
    assert.equal(cookies.length, 2, 'set-cookie не должен схлопываться');
    assert.match(cookies[0]!.value, /^a=1/);
    assert.match(cookies[1]!.value, /^b=2/);
  } finally {
    await app.close();
  }
});

test('M12: inject работает со стрим-ответом и бинарным телом', async () => {
  const app = new Server();
  app.get('/stream', (c) =>
    c.body(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('часть-1|'));
          ctrl.enqueue(new TextEncoder().encode('часть-2'));
          ctrl.close();
        },
      }),
    ),
  );
  app.get('/binary', (c) => c.body(Buffer.from([0x00, 0xff, 0x10])));
  try {
    assert.equal((await app.inject({ path: '/stream' })).text(), 'часть-1|часть-2');
    const bin = await app.inject({ path: '/binary' });
    assert.deepEqual([...bin.body], [0x00, 0xff, 0x10]);
  } finally {
    await app.close();
  }
});

test('M12: inject учитывается в метриках как обычный запрос', async () => {
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

test('M12: inject после close() не воскрешает сервер молча', async () => {
  const app = new Server();
  app.get('/', (c) => c.text('ok'));
  await app.inject({ path: '/' });
  await app.close();
  // Автоподъём работает только для ни разу не запущенного сервера: после явного
  // close() тихо занять новый порт было бы сюрпризом.
  await assert.rejects(() => app.inject({ path: '/' }), /закрыт/);
});

test('M12: inject отвергает заголовок, который HTTP не передаёт', async () => {
  const app = new Server();
  app.get('/h', (c) => c.json({ got: c.req.header('authorization') ?? null }));
  try {
    // Реальный fetch на такое отвечает ошибкой ByteString — харнесс обязан тоже,
    // иначе тест был бы зелёным там, где сеть отказывает.
    await assert.rejects(
      () => app.inject({ path: '/h', headers: { authorization: 'Bearer секрет' } }),
      /вне диапазона байта/,
    );
    // ASCII-значение проходит как обычно.
    const ok = await app.inject({ path: '/h', headers: { authorization: 'Bearer secret' } });
    assert.equal(ok.json<{ got: string }>().got, 'Bearer secret');
  } finally {
    await app.close();
  }
});
