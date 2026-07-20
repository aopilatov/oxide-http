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

/** A handler that blocks until released. */
function gate() {
  let release;
  const opened = new Promise<any>((r) => (release = r));
  return { opened, release: () => release() };
}

test('M10b: beyond the limit → 503 + Retry-After', async () => {
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
    // Occupy the only slot.
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

test('M10b: the queue lets a burst through instead of refusing it', async () => {
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

    // The second one is not refused immediately — it waits in the queue.
    const queued = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 150));

    g.release(); // free the slot — the queued request should go through
    assert.equal((await first).status, 200);
    assert.equal((await queued).status, 200, 'the queued request must be served');
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: a full queue → 503 without waiting', async () => {
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
    const first = fetch(`http://127.0.0.1:${s.port}/hold`); // took the slot
    await new Promise<void>((r) => setTimeout(r, 120));
    const queued = fetch(`http://127.0.0.1:${s.port}/hold`); // took the queue
    await new Promise<void>((r) => setTimeout(r, 120));

    // The third has room neither in a slot nor in the queue — the refusal must be fast,
    // not after queueTimeout (5s).
    const t0 = Date.now();
    const third = await fetch(`http://127.0.0.1:${s.port}/hold`);
    const elapsed = Date.now() - t0;

    assert.equal(third.status, 503);
    assert.ok(elapsed < 1500, `the refusal must be fast, took ${elapsed}ms`);

    g.release();
    await first;
    await queued;
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: queueTimeout expired → 503', async () => {
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
    assert.equal(timedOut.status, 503, 'queue waiting must not be unbounded');

    g.release();
    assert.equal((await first).status, 200);
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: probes answer under overload', async () => {
  const g = gate();
  const s = await up({
    config: { maxConcurrentRequests: 1, health: { metricsPath: '/metrics' } },
    routes: (app) =>
      app.get('/hold', async (c) => {
        await g.opened;
        return c.text('ok');
      }),
  });
  try {
    const first = fetch(`http://127.0.0.1:${s.port}/hold`);
    await new Promise<void>((r) => setTimeout(r, 120));

    // The slot is taken, but probes must still answer — otherwise k8s never learns about
    // the overload.
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

test('M10b: sustained overload drops readiness, relief restores it', async () => {
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

    // First refusal: the overload has just begun — readiness still holds.
    await fetch(`http://127.0.0.1:${s.port}/hold`);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/readyz`)).status, 200);

    // The overload lasts beyond the threshold — time to pull the pod from endpoints.
    await new Promise<void>((r) => setTimeout(r, 300));
    await fetch(`http://127.0.0.1:${s.port}/hold`);
    const shed = await fetch(`http://127.0.0.1:${s.port}/readyz`);
    assert.equal(shed.status, 503);
    assert.equal(await shed.text(), 'overloaded');

    // Load is gone — readiness comes back.
    g.release();
    await first;
    await fetch(`http://127.0.0.1:${s.port}/hold`);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/readyz`)).status, 200);
  } finally {
    g.release();
    await s.close();
  }
});

test('M10b: h2 receives GOAWAY on an overload refusal', async () => {
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

    // The first stream takes the slot.
    const held = client.request({ ':path': '/hold' });
    held.on('error', () => {});
    held.end();
    await new Promise<void>((r) => setTimeout(r, 150));

    // The second stream is refused with 503 — and the connection must close with GOAWAY
    // so the client reconnects (possibly to another replica).
    const status = await new Promise<any>((resolve, reject) => {
      const req = client.request({ ':path': '/hold' });
      req.on('response', (h) => resolve(h[':status']));
      req.on('error', reject);
      req.resume();
      req.end();
    });
    assert.equal(status, 503);

    await new Promise<void>((r) => setTimeout(r, 250));
    assert.equal(goaway, true, 'the client must receive GOAWAY');
  } finally {
    g.release();
    client.close();
    await s.close();
  }
});

test('M10b: without a limit nothing is refused', async () => {
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
