import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Server } from '../js/index.ts';
const here = dirname(fileURLToPath(import.meta.url));

let PORT = 39400;
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

test('M11: /healthz отвечает 200 без пробуждения JS', async () => {
  let handlerCalled = false;
  const s = await up({
    routes: (app) => app.get('/healthz', () => ((handlerCalled = true), 'из JS')),
  });
  try {
    const res = await get(s.port, '/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'ok');
    // Нативная проба перехватывает путь раньше роутера.
    assert.equal(handlerCalled, false, 'JS-хендлер не должен вызываться');
  } finally {
    await s.close();
  }
});

test('M11: /readyz — 200 по умолчанию, 503 после setReady(false)', async () => {
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

test('M11: setReadinessCheck снимает готовность при провале колбэка', async () => {
  let healthy = true;
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  try {
    s.server.setReadinessCheck(() => healthy, { interval: 60 });
    await new Promise<void>((r) => setTimeout(r, 150));
    assert.equal((await get(s.port, '/readyz')).status, 200);

    healthy = false; // например, отвалилась БД
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal((await get(s.port, '/readyz')).status, 503);

    healthy = true;
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal((await get(s.port, '/readyz')).status, 200);
  } finally {
    await s.close();
  }
});

test('M11: упавший или зависший readinessCheck = не готов', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  try {
    s.server.setReadinessCheck(
      () => {
        throw new Error('БД недоступна');
      },
      { interval: 60 },
    );
    await new Promise<void>((r) => setTimeout(r, 200));
    assert.equal((await get(s.port, '/readyz')).status, 503, 'throw → не готов');

    // Зависший колбэк не должен держать readiness «готовым» вечно.
    s.server.setReadinessCheck(() => new Promise<void>(() => {}), { interval: 60, timeout: 80 });
    await new Promise<void>((r) => setTimeout(r, 300));
    assert.equal((await get(s.port, '/readyz')).status, 503, 'таймаут → не готов');
  } finally {
    await s.close();
  }
});

test('M11: /metrics отдаёт формат Prometheus и считает запросы', async () => {
  const s = await up({
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

test('M11: метрики считают байты тел', async () => {
  const s = await up({
    routes: (app) => app.post('/echo', async (c) => c.text(await c.req.text())),
  });
  try {
    await fetch(`http://127.0.0.1:${s.port}/echo`, { method: 'POST', body: 'x'.repeat(500) });
    const res = await get(s.port, '/metrics');
    const req = Number(res.body.match(/http_request_body_bytes_total (\d+)/)![1]);
    const resp = Number(res.body.match(/http_response_body_bytes_total (\d+)/)![1]);
    assert.ok(req >= 500, `прочитано байт запроса: ${req}`);
    assert.ok(resp >= 500, `записано байт ответа: ${resp}`);
  } finally {
    await s.close();
  }
});

test('M11: health на отдельном порту, на основном его нет', async () => {
  const adminPort = nextPort();
  const s = await up({
    config: { health: { port: adminPort } },
    routes: (app) => app.get('/', (c) => c.text('app')),
  });
  try {
    // На admin-порту пробы есть.
    assert.equal((await get(adminPort, '/healthz')).status, 200);
    assert.equal((await get(adminPort, '/readyz')).status, 200);
    assert.match((await get(adminPort, '/metrics')).body, /http_requests_total|# TYPE/);
    // Прикладных маршрутов там нет.
    assert.equal((await get(adminPort, '/')).status, 404);

    // На основном порту метрик быть не должно — их не светят наружу.
    assert.equal((await get(s.port, '/metrics')).status, 404);
    assert.equal((await get(s.port, '/healthz')).status, 404);
    assert.equal((await get(s.port, '/')).body, 'app');
  } finally {
    await s.close();
  }
});

test('M11: пути проб настраиваются и выключаются', async () => {
  const s = await up({
    config: { health: { path: '/_alive', readyPath: '/_ready', metricsPath: '' } },
    routes: (app) => app.get('/', (c) => c.text('app')),
  });
  try {
    assert.equal((await get(s.port, '/_alive')).status, 200);
    assert.equal((await get(s.port, '/_ready')).status, 200);
    assert.equal((await get(s.port, '/healthz')).status, 404, 'дефолтный путь отключён');
    assert.equal((await get(s.port, '/metrics')).status, 404, 'метрики выключены');
  } finally {
    await s.close();
  }
});

test('M11: preShutdownDelay — readyz уже 503, но сервер ещё принимает запросы', async () => {
  const s = await up({
    // Окно, в котором под снят с эндпоинтов, но продолжает обслуживать трафик,
    // который балансировщик ещё не успел перенаправить.
    config: { preShutdownDelay: '800ms' },
    routes: (app) => app.get('/', (c) => c.text('still-serving')),
  });

  const closing = s.close();
  await new Promise<void>((r) => setTimeout(r, 200));

  const ready = await get(s.port, '/readyz');
  assert.equal(ready.status, 503, 'под должен сняться с эндпоинтов сразу');
  assert.equal(ready.body, 'draining');
  assert.equal((await get(s.port, '/healthz')).status, 200, 'liveness остаётся 200');

  // Главное: соединения в этом окне ещё принимаются, а не отбиваются RST.
  const res = await get(s.port, '/');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'still-serving');

  await closing;
  // После окна listener закрыт — новые соединения уже не проходят.
  await assert.rejects(() => fetch(`http://127.0.0.1:${s.port}/`));
});

test('M11: без preShutdownDelay listener закрывается сразу, in-flight дожимается', async () => {
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

  // Дефолт (0) — прежнее поведение: приём прекращён немедленно.
  await assert.rejects(() => fetch(`http://127.0.0.1:${s.port}/slow`));

  await closing;
  assert.equal((await inflight).status, 200, 'принятый запрос всё равно дожимается');
});

test('M11: accessLog печатает JSON-строку на запрос', async () => {
  const port = nextPort();
  const child = spawn(process.execPath, [join(here, 'fixtures/access-log-server.ts'), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise<void>((resolve, reject) => {
      const wait = setInterval(() => (out.includes('ready') ? (clearInterval(wait), resolve()) : null), 50);
      setTimeout(() => (clearInterval(wait), reject(new Error('сервер не поднялся'))), 5000);
    });

    await fetch(`http://127.0.0.1:${port}/hello?q=1`);
    await new Promise<void>((r) => setTimeout(r, 200));

    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{') && l.includes('"msg":"request"'));
    assert.ok(line, `в stdout нет строки access-log:\n${out}`);

    const entry = JSON.parse(line);
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/hello');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, 'number');
  } finally {
    child.kill('SIGKILL');
  }
});
