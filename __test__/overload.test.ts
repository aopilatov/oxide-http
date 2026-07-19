import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';

import { Server } from '../js/index.ts';

let PORT = 21600;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config ?? {});
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

/** Хендлер, который держится, пока его не отпустят. */
function gate() {
  let release;
  const opened = new Promise<any>((r) => (release = r));
  return { opened, release: () => release() };
}

test('M10b: сверх лимита → 503 + Retry-After', async () => {
  const g = gate();
  const s = await up({
    config: { maxConcurrentRequests: 1 },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('held');
      }),
  });
  try {
    // Занимаем единственный слот.
    const first = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 120));

    const second = await fetch(`http://127.0.0.1:${s.port}/hold`);
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '1');
    assert.match(await second.text(), /Service Unavailable/);

    g.release();
    assert.equal((await first).status, 200);
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: очередь пропускает всплеск, а не отбивает его', async () => {
  const g = gate();
  const s = await up({
    config: { maxConcurrentRequests: 1, maxQueue: 4, queueTimeout: '2s' },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('ok');
      }),
  });
  try {
    const first = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 120));

    // Второй не отбивается сразу — он ждёт слот в очереди.
    const queued = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 150));

    g.release(); // освобождаем слот — очередь должна пройти
    assert.equal((await first).status, 200);
    assert.equal((await queued).status, 200, 'запрос из очереди должен обслужиться');
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: переполненная очередь → 503 без ожидания', async () => {
  const g = gate();
  const s = await up({
    config: { maxConcurrentRequests: 1, maxQueue: 1, queueTimeout: '5s' },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('ok');
      }),
  });
  try {
    const first = fetch(`http://127.0.0.1:${s.port}/hold`); // занял слот
    await new Promise<void>((r) => setTimeout(r, 120));
    const queued = fetch(`http://127.0.0.1:${s.port}/hold`); // занял очередь
    await new Promise<void>((r) => setTimeout(r, 120));

    // Третьему места нет ни в слоте, ни в очереди — отказ должен прийти быстро,
    // а не через queueTimeout (5с).
    const t0 = Date.now();
    const third = await fetch(`http://127.0.0.1:${s.port}/hold`);
    const elapsed = Date.now() - t0;

    assert.equal(third.status, 503);
    assert.ok(elapsed < 1500, `отказ должен быть быстрым, занял ${elapsed}ms`);

    g.release();
    await first;
    await queued;
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: queueTimeout истёк → 503', async () => {
  const g = gate();
  const s = await up({
    config: { maxConcurrentRequests: 1, maxQueue: 4, queueTimeout: '200ms' },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('ok');
      }),
  });
  try {
    const first = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 120));

    const timedOut = await fetch(`http://127.0.0.1:${s.port}/hold`);
    assert.equal(timedOut.status, 503, 'ожидание в очереди не должно быть бесконечным');

    g.release();
    assert.equal((await first).status, 200);
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: пробы отвечают под перегрузкой', async () => {
  const g = gate();
  const s = await up({
    config: { maxConcurrentRequests: 1 },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('ok');
      }),
  });
  try {
    const first = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 120));

    // Слот занят, но пробы обязаны отвечать — иначе k8s не узнает о перегрузке.
    const health = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    assert.equal(health.status, 200);
    const metrics = await fetch(`http://127.0.0.1:${s.port}/metrics`);
    assert.equal(metrics.status, 200);

    g.release();
    await first;
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: устойчивая перегрузка снимает readiness, разгрузка возвращает', async () => {
  const g = gate();
  const s = await up({
    config: { maxConcurrentRequests: 1, overloadShedAfter: '250ms' },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('ok');
      }),
  });
  try {
    const first = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 100));

    // Первый отказ: перегрузка только началась — readiness ещё держим.
    await fetch(`http://127.0.0.1:${s.port}/hold`);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/readyz`)).status, 200);

    // Перегрузка держится дольше порога — под пора снимать с эндпоинтов.
    await new Promise<void>((r) => setTimeout(r, 300));
    await fetch(`http://127.0.0.1:${s.port}/hold`);
    const shed = await fetch(`http://127.0.0.1:${s.port}/readyz`);
    assert.equal(shed.status, 503);
    assert.equal(await shed.text(), 'overloaded');

    // Разгрузились — readiness возвращается.
    g.release();
    await first;
    await fetch(`http://127.0.0.1:${s.port}/hold`);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/readyz`)).status, 200);
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: h2 получает GOAWAY при отказе по перегрузке', async () => {
  const g = gate();
  const s = await up({
    config: { h2c: true, maxConcurrentRequests: 1 },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('ok');
      }),
  });
  const client = http2.connect(`http://127.0.0.1:${s.port}`);
  try {
    let goaway = false;
    client.on('goaway', () => (goaway = true));

    // Первый стрим занимает слот.
    const held = client.request({ ':path': '/hold' });
    held.on('error', () => {});
    held.end();
    await new Promise<void>((r) => setTimeout(r, 150));

    // Второй стрим отбивается 503 — и соединение должно закрыться GOAWAY,
    // чтобы клиент переоткрылся (возможно, уже на другую реплику).
    const status = await new Promise<any>((resolve, reject) => {
      const req = client.request({ ':path': '/hold' });
      req.on('response', (h) => resolve(h[':status']));
      req.on('error', reject);
      req.resume();
      req.end();
    });
    assert.equal(status, 503);

    await new Promise<void>((r) => setTimeout(r, 250));
    assert.equal(goaway, true, 'клиент должен получить GOAWAY');
  } finally {
    g.release();
    client.close();
    await s.close();
  }
});

test('M10b: без лимита ничего не отбивается', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 200));
        return c.text('ok');
      }),
  });
  try {
    const all = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${s.port}/slow`)),
    );
    assert.deepEqual(
      all.map((r) => r.status),
      Array(8).fill(200),
    );
  } finally {
    await s.close();
  }
});
