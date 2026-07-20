import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Server } from '../js/index.ts';
const here = dirname(fileURLToPath(import.meta.url));

let PORT = 21400;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config ?? {});
  build.routes?.(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

const get = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text(), headers: res.headers };
};

test('M11: /healthz answers 200 without waking JS', async () => {
  // Registering a route on /healthz is now a listen() error (it could never run), so the
  // "JS stayed asleep" property is proven with a global middleware plus notFound —
  // between them every path into JS is covered.
  let jsWoken = false;
  const s = await up({
    routes: (app) => {
      app.use((_c, next) => ((jsWoken = true), next()));
      app.notFound((c) => ((jsWoken = true), c.text('nf', 404)));
      app.get('/', (c) => c.text('app'));
    },
  });
  try {
    const res = await get(s.port, '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
    // The native probe intercepts the path before the router.
    assert.equal(jsWoken, false, 'the probe must be answered entirely in Rust');
  } finally {
    await s.close();
  }
});

test('M11: /readyz — 200 by default, 503 after setReady(false)', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  try {
    let res = await get(s.port, '/readyz');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ready');

    s.server.setReady(false);
    res = await get(s.port, '/readyz');
    assert.equal(res.status, 503);
    assert.equal(res.body, 'not-ready');

    s.server.setReady(true);
    res = await get(s.port, '/readyz');
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

test('M11: setReadinessCheck drops readiness when the callback fails', async () => {
  let healthy = true;
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  try {
    s.server.setReadinessCheck(() => healthy, { interval: 60 });
    await new Promise<void>((r) => setTimeout(r, 150));
    assert.equal((await get(s.port, '/readyz')).status, 200);

    healthy = false; // e.g. the database went away
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal((await get(s.port, '/readyz')).status, 503);

    healthy = true;
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal((await get(s.port, '/readyz')).status, 200);
  } finally {
    await s.close();
  }
});

test('M11: a throwing or hanging readinessCheck means not ready', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  try {
    s.server.setReadinessCheck(
      () => {
        throw new Error('database unavailable');
      },
      { interval: 60 },
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal((await get(s.port, '/readyz')).status, 503, 'throw → not ready');

    // A hanging callback must not keep readiness "ready" forever.
    s.server.setReadinessCheck(() => new Promise<void>(() => {}), { interval: 60, timeout: 80 });
    await new Promise<void>((r) => setTimeout(r, 300));
    assert.equal((await get(s.port, '/readyz')).status, 503, 'timeout → not ready');
  } finally {
    await s.close();
  }
});

test('M11: /metrics returns Prometheus format and counts requests', async () => {
  const s = await up({
    // Metrics are off on the main port by default — opt in explicitly.
    config: { health: { metricsPath: '/metrics' } },
    routes: (app) => {
      app.get('/ok', (c) => c.text('ok'));
      app.post('/bad', (c) => c.text('nope', 404));
    },
  });
  try {
    await get(s.port, '/ok');
    await get(s.port, '/ok');
    await fetch(`http://127.0.0.1:${s.port}/bad`, { method: 'POST' });

    const res = await get(s.port, '/metrics');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/plain.*version=0\.0\.4/);

    assert.match(res.body, /# TYPE http_requests_total counter/);
    assert.match(res.body, /http_requests_total\{method="GET",status="2xx"\} 2/);
    assert.match(res.body, /http_requests_total\{method="POST",status="4xx"\} 1/);
    assert.match(res.body, /# TYPE http_request_duration_seconds histogram/);
    assert.match(res.body, /http_request_duration_seconds_bucket\{le="\+Inf"\} \d+/);
    assert.match(res.body, /http_requests_in_flight \d+/);
    assert.match(res.body, /http_connections_active \d+/);
  } finally {
    await s.close();
  }
});

test('M11: metrics count body bytes', async () => {
  const s = await up({
    config: { health: { metricsPath: '/metrics' } },
    routes: (app) => app.post('/echo', async (c) => c.text(await c.req.text())),
  });
  try {
    await fetch(`http://127.0.0.1:${s.port}/echo`, { method: 'POST', body: 'x'.repeat(500) });
    const res = await get(s.port, '/metrics');
    const req = Number(res.body.match(/http_request_body_bytes_total (\d+)/)![1]);
    const resp = Number(res.body.match(/http_response_body_bytes_total (\d+)/)![1]);
    assert.ok(req >= 500, `request bytes read: ${req}`);
    assert.ok(resp >= 500, `response bytes written: ${resp}`);
  } finally {
    await s.close();
  }
});

test('M11: health on a separate port, absent from the main one', async () => {
  const adminPort = nextPort();
  const s = await up({
    config: { health: { port: adminPort } },
    routes: (app) => app.get('/', (c) => c.text('app')),
  });
  try {
    // The probes exist on the admin port.
    assert.equal((await get(adminPort, '/healthz')).status, 200);
    assert.equal((await get(adminPort, '/readyz')).status, 200);
    assert.match((await get(adminPort, '/metrics')).body, /http_requests_total|# TYPE/);
    // Application routes do not.
    assert.equal((await get(adminPort, '/')).status, 404);

    // The main port must not expose metrics — they stay internal.
    assert.equal((await get(s.port, '/metrics')).status, 404);
    assert.equal((await get(s.port, '/healthz')).status, 404);
    assert.equal((await get(s.port, '/')).body, 'app');
  } finally {
    await s.close();
  }
});

test('D2: streamed response bytes are counted too', async () => {
  // Only the buffered path incremented the counter, so a streaming endpoint reported
  // zero response bytes no matter how much it sent.
  const s = await up({
    config: { health: { metricsPath: '/metrics' } },
    routes: (app) =>
      app.get('/stream', (c) =>
        c.body(
          new ReadableStream({
            start(controller) {
              for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(256)));
              controller.close();
            },
          }),
        ),
      ),
  });
  try {
    await (await fetch(`http://127.0.0.1:${s.port}/stream`)).text();
    const res = await get(s.port, '/metrics');
    const sent = Number(res.body.match(/http_response_body_bytes_total (\d+)/)![1]);
    assert.ok(sent >= 1024, `streamed bytes must be counted, got ${sent}`);
  } finally {
    await s.close();
  }
});

test('A6: /metrics is off on the main port unless asked for', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('app')) });
  try {
    // Liveness/readiness stay on — k8s needs them. Metrics are an information-disclosure
    // surface, so they require an explicit opt-in or a dedicated admin port.
    assert.equal((await get(s.port, '/healthz')).status, 200);
    assert.equal((await get(s.port, '/readyz')).status, 200);
    assert.equal((await get(s.port, '/metrics')).status, 404, 'metrics must not be public');
  } finally {
    await s.close();
  }
});

test('F1: bodies buffered for schema validation are counted too', async () => {
  // Only read_body_task counted bytes, so any route with a body schema was missing from
  // the request-byte counter entirely.
  const v = await import('valibot');
  const s = await up({
    config: { health: { metricsPath: '/metrics' } },
    routes: (app) =>
      app.post(
        '/validated',
        { schema: { body: v.object({ pad: v.string() }) } },
        (c) => c.json(c.req.valid('body')),
      ),
  });
  try {
    const payload = JSON.stringify({ pad: 'x'.repeat(2000) });
    const res = await fetch(`http://127.0.0.1:${s.port}/validated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(res.status, 200);

    const metrics = await get(s.port, '/metrics');
    const read = Number(metrics.body.match(/http_request_body_bytes_total (\d+)/)![1]);
    assert.ok(read >= payload.length, `schema-buffered bytes must be counted, got ${read}`);
  } finally {
    await s.close();
  }
});

test('F2: a parametric route that would swallow a probe path fails listen()', async () => {
  // The check used to compare pattern strings, so '/:page' passed — and then shadowed
  // /healthz at runtime, which is the exact trap the check exists to prevent.
  const app = new Server();
  app.get('/:page', (c) => c.text('page'));
  await assert.rejects(
    () => app.listen({ port: nextPort(), host: '127.0.0.1' }),
    /collides with the health endpoint/,
  );

  // A wildcard is caught the same way.
  const wild = new Server();
  wild.get('/*rest', (c) => c.text('any'));
  await assert.rejects(
    () => wild.listen({ port: nextPort(), host: '127.0.0.1' }),
    /collides with the health endpoint/,
  );

  // A non-GET route on the probe path is fine: probes only answer GET/HEAD.
  const post = new Server();
  post.post('/healthz', (c) => c.text('posted'));
  const port = nextPort();
  await post.listen({ port, host: '127.0.0.1' });
  try {
    assert.equal((await get(port, '/healthz')).body, 'ok', 'GET still reaches the probe');
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { method: 'POST' });
    assert.equal(await res.text(), 'posted');
  } finally {
    await post.close();
  }
});

test('A6: a route colliding with a probe path fails listen()', async () => {
  // The probe is answered in Rust before routing, so this handler could never run.
  // Failing loudly beats a route that silently does nothing.
  const app = new Server();
  app.get('/healthz', (c) => c.text('mine'));
  await assert.rejects(
    () => app.listen({ port: nextPort(), host: '127.0.0.1' }),
    /collides with the health endpoint/,
  );

  // Disabling the endpoint frees the path.
  const ok = new Server({ health: { path: '' } });
  ok.get('/healthz', (c) => c.text('mine'));
  const port = nextPort();
  await ok.listen({ port, host: '127.0.0.1' });
  try {
    assert.equal((await get(port, '/healthz')).body, 'mine');
  } finally {
    await ok.close();
  }
});

test('M11: probe paths are configurable and can be disabled', async () => {
  const s = await up({
    config: { health: { path: '/_alive', readyPath: '/_ready', metricsPath: '' } },
    routes: (app) => app.get('/', (c) => c.text('app')),
  });
  try {
    assert.equal((await get(s.port, '/_alive')).status, 200);
    assert.equal((await get(s.port, '/_ready')).status, 200);
    assert.equal((await get(s.port, '/healthz')).status, 404, 'the default path is disabled');
    assert.equal((await get(s.port, '/metrics')).status, 404, 'metrics are disabled');
  } finally {
    await s.close();
  }
});

test('M11: preShutdownDelay — readyz is already 503 while the server still accepts', async () => {
  const s = await up({
    // The window where the pod has left the endpoints but keeps serving traffic the
    // balancer has not redirected yet.
    config: { preShutdownDelay: '800ms' },
    routes: (app) => app.get('/', (c) => c.text('still-serving')),
  });

  const closing = s.close();
  await new Promise<void>((r) => setTimeout(r, 200));

  const ready = await get(s.port, '/readyz');
  assert.equal(ready.status, 503, 'the pod must leave the endpoints immediately');
  assert.equal(ready.body, 'draining');
  assert.equal((await get(s.port, '/healthz')).status, 200, 'liveness stays 200');

  // The key part: connections in this window are still accepted, not reset.
  const res = await get(s.port, '/');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'still-serving');

  await closing;
  // After the window the listener is closed — new connections no longer get through.
  await assert.rejects(() => fetch(`http://127.0.0.1:${s.port}/`));
});

test('M11: without preShutdownDelay the listener closes at once while in-flight finishes', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 500));
        return c.text('done');
      }),
  });

  const inflight = fetch(`http://127.0.0.1:${s.port}/slow`);
  await new Promise<void>((r) => setTimeout(r, 100));
  const closing = s.close();
  await new Promise<void>((r) => setTimeout(r, 150));

  // The default (0) keeps the old behaviour: accepting stops immediately.
  await assert.rejects(() => fetch(`http://127.0.0.1:${s.port}/slow`));

  await closing;
  assert.equal((await inflight).status, 200, 'the accepted request still finishes');
});

test('M11: accessLog prints a JSON line per request', async () => {
  const port = nextPort();
  const child = spawn(process.execPath, [join(here, 'fixtures/access-log-server.ts'), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise<void>((resolve, reject) => {
      const wait = setInterval(() => (out.includes('ready') ? (clearInterval(wait), resolve()) : null), 50);
      setTimeout(() => (clearInterval(wait), reject(new Error('the server did not start'))), 5000);
    });

    await fetch(`http://127.0.0.1:${port}/hello?q=1`);
    await new Promise<void>((r) => setTimeout(r, 200));

    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{') && l.includes('"msg":"request"'));
    assert.ok(line, `no access-log line in stdout:\n${out}`);

    const entry = JSON.parse(line);
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/hello');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, 'number');
  } finally {
    child.kill('SIGKILL');
  }
});
