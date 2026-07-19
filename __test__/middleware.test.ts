import test from 'node:test';
import assert from 'node:assert/strict';

import { Server } from '../js/index.ts';

let PORT = 38500;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('M5: порядок луковицы (before → handler → after)', async () => {
  const order: string[] = [];
  const s = await up({
    routes: (app) => {
      app.use(async (c, next) => {
        order.push('A-before');
        await next();
        order.push('A-after');
      });
      app.use(async (c, next) => {
        order.push('B-before');
        await next();
        order.push('B-after');
      });
      app.get('/x', (c) => {
        order.push('handler');
        return c.text('ok');
      });
    },
  });
  try {
    await (await fetch(`${s.base}/x`)).text();
    assert.deepEqual(order, ['A-before', 'B-before', 'handler', 'B-after', 'A-after']);
  } finally {
    s.close();
  }
});

test('M5: порядок хуков жизненного цикла', async () => {
  const order: string[] = [];
  const s = await up({
    routes: (app) => {
      app.onRequest((c) => order.push('onRequest'));
      app.preHandler((c) => order.push('preHandler'));
      app.preSerialization((c) => order.push('preSerialization'));
      app.onSend((c) => order.push('onSend'));
      app.onResponse((c) => order.push('onResponse'));
      app.use(async (c, next) => {
        order.push('mw-before');
        await next();
        order.push('mw-after');
      });
      app.get('/x', (c) => {
        order.push('handler');
        return c.text('ok');
      });
    },
  });
  try {
    await (await fetch(`${s.base}/x`)).text();
    assert.deepEqual(order, [
      'onRequest',
      'preHandler',
      'mw-before',
      'handler',
      'mw-after',
      'preSerialization',
      'onSend',
      'onResponse',
    ]);
  } finally {
    s.close();
  }
});

test('M5: short-circuit из onRequest (хендлер пропущен, onSend/onResponse идут)', async () => {
  const order: string[] = [];
  const s = await up({
    routes: (app) => {
      app.onRequest((c) => {
        order.push('onRequest');
        c.text('blocked', 401); // short-circuit
      });
      app.preHandler((c) => order.push('preHandler')); // не должен вызваться
      app.onSend((c) => order.push('onSend'));
      app.onResponse((c) => order.push('onResponse'));
      app.get('/x', (c) => {
        order.push('handler');
        return c.text('ok');
      });
    },
  });
  try {
    const res = await fetch(`${s.base}/x`);
    assert.equal(res.status, 401);
    assert.equal(await res.text(), 'blocked');
    assert.deepEqual(order, ['onRequest', 'onSend', 'onResponse']);
  } finally {
    s.close();
  }
});

test('M5: onError ловит throw из любого слоя', async () => {
  const s = await up({
    routes: (app) => {
      app.onError((err, c) => c.json({ caught: err.message }, 500));
      app.get('/h', () => {
        throw new Error('boom-handler');
      });
      app.get('/m', async (c, next) => {
        await next();
      });
      app.use('/m', async () => {
        throw new Error('boom-mw');
      });
    },
  });
  try {
    const h = await fetch(`${s.base}/h`);
    assert.equal(h.status, 500);
    assert.deepEqual(await h.json(), { caught: 'boom-handler' });
  } finally {
    s.close();
  }
});

test('M5: throw без onError → дефолтный 500, процесс жив', async () => {
  const s = await up({
    routes: (app) => app.get('/boom', () => {
      throw new Error('unhandled');
    }),
  });
  try {
    const res = await fetch(`${s.base}/boom`);
    assert.equal(res.status, 500);
    // процесс жив — следующий запрос работает
    const ok = await fetch(`${s.base}/boom`);
    assert.equal(ok.status, 500);
  } finally {
    s.close();
  }
});

test('M5: таймаут → 504 + onTimeout + AbortSignal', async () => {
  let aborted = false;
  let onTimeoutRan = false;
  const s = await up({
    config: { requestTimeout: '50ms' },
    routes: (app) => {
      app.onTimeout(() => {
        onTimeoutRan = true;
      });
      app.get('/slow', async (c) => {
        c.req.signal.addEventListener('abort', () => (aborted = true));
        await new Promise<void>((r) => setTimeout(r, 500)); // дольше таймаута
        return c.text('too late');
      });
    },
  });
  try {
    const res = await fetch(`${s.base}/slow`);
    assert.equal(res.status, 504);
    assert.equal(onTimeoutRan, true);
    assert.equal(aborted, true, 'signal должен сработать');
  } finally {
    s.close();
  }
});

test('M5: маршрутные middleware и route-опции хуков', async () => {
  const order: string[] = [];
  const mw = async (c, next) => {
    order.push('route-mw');
    await next();
  };
  const s = await up({
    routes: (app) =>
      app.get('/x', { onRequest: [(c) => order.push('route-onRequest')] }, mw, (c) => {
        order.push('handler');
        return c.text('ok');
      }),
  });
  try {
    await (await fetch(`${s.base}/x`)).text();
    assert.deepEqual(order, ['route-onRequest', 'route-mw', 'handler']);
  } finally {
    s.close();
  }
});

test('M5: инкапсуляция групп — хуки суба не текут на родителя', async () => {
  const seen: unknown[] = [];
  const sub = new Server();
  sub.onRequest((c) => seen.push(`sub-hook:${c.req.path}`));
  sub.get('/inner', (c) => c.text('inner'));

  const s = await up({
    routes: (app) => {
      app.get('/outer', (c) => c.text('outer'));
      app.route('/g', sub);
    },
  });
  try {
    await (await fetch(`${s.base}/g/inner`)).text();
    await (await fetch(`${s.base}/outer`)).text();
    // sub-хук сработал только на /g/inner, не на /outer
    assert.deepEqual(seen, ['sub-hook:/g/inner']);
  } finally {
    s.close();
  }
});

test('M5: префиксный use применяется только под префиксом', async () => {
  const hits: string[] = [];
  const s = await up({
    routes: (app) => {
      app.use('/admin/*', async (c, next) => {
        hits.push(c.req.path);
        await next();
      });
      app.get('/admin/panel', (c) => c.text('a'));
      app.get('/public', (c) => c.text('p'));
    },
  });
  try {
    await (await fetch(`${s.base}/admin/panel`)).text();
    await (await fetch(`${s.base}/public`)).text();
    assert.deepEqual(hits, ['/admin/panel']);
  } finally {
    s.close();
  }
});

test('M5: onSend может доработать заголовки ответа', async () => {
  const s = await up({
    routes: (app) => {
      app.onSend((c) => c.header('x-powered-by', 'oxide'));
      app.get('/x', (c) => c.text('ok'));
    },
  });
  try {
    const res = await fetch(`${s.base}/x`);
    assert.equal(res.headers.get('x-powered-by')!, 'oxide');
  } finally {
    s.close();
  }
});
