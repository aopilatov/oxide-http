import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { Server } = require('../js/index.js');
const here = dirname(fileURLToPath(import.meta.url));

let PORT = 39000;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config ?? {});
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

test('M10a: listen эмитит listening, close эмитит shutdown+close', async () => {
  const server = new Server();
  server.get('/', (c) => c.text('ok'));
  const seen = [];
  server.on('listening', (info) => seen.push(['listening', info.port]));
  server.on('shutdown', () => seen.push(['shutdown']));
  server.on('close', () => seen.push(['close']));

  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  assert.equal(server.listening, true);
  await server.close();
  assert.equal(server.listening, false);

  assert.deepEqual(seen, [['listening', port], ['shutdown'], ['close']]);
});

test('M10a: занятый порт → listen реджектится и эмитит error', async () => {
  const first = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  try {
    const second = new Server();
    second.get('/', (c) => c.text('dup'));
    let emitted = null;
    second.on('error', (e) => (emitted = e));

    await assert.rejects(
      () => second.listen({ port: first.port, host: '127.0.0.1' }),
      /Address already in use|bind/,
    );
    assert.ok(emitted, 'событие error должно прийти');
    assert.equal(second.listening, false);
  } finally {
    await first.close();
  }
});

test('M10a: close() дожидается in-flight запроса', async () => {
  let handlerDone = false;
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise((r) => setTimeout(r, 600));
        handlerDone = true;
        return c.text('finished');
      }),
  });

  // Запрос в полёте, ответ ещё не пришёл.
  const inflight = fetch(`http://127.0.0.1:${s.port}/slow`);
  await new Promise((r) => setTimeout(r, 150));

  await s.close(); // должен дождаться, а не оборвать
  assert.equal(handlerDone, true, 'хендлер должен был досчитать до конца close()');

  const res = await inflight;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'finished');
});

test('M10a: порт освобождается сразу — можно забиндиться после close()', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('first')) });
  await s.close();

  // Тот же порт должен быть свободен немедленно после резолва close().
  const again = new Server();
  again.get('/', (c) => c.text('second'));
  await again.listen({ port: s.port, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(await res.text(), 'second');
  } finally {
    await again.close();
  }
});

test('M10a: close() идемпотентен, параллельные вызовы ждут один drain', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  const closes = [s.close(), s.close(), s.close()];
  await Promise.all(closes);
  await s.close(); // после завершения — тоже no-op
  assert.equal(s.server.listening, false);
});

test('M10a: shutdownTimeout обрывает застрявший запрос', async () => {
  const s = await up({
    config: { shutdownTimeout: '300ms' },
    routes: (app) =>
      app.get('/stuck', async (c) => {
        await new Promise((r) => setTimeout(r, 10_000)); // дольше дедлайна
        return c.text('never');
      }),
  });

  const inflight = fetch(`http://127.0.0.1:${s.port}/stuck`).catch((e) => e);
  await new Promise((r) => setTimeout(r, 150));

  const t0 = Date.now();
  await s.close();
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 3000, `close() должен уложиться в дедлайн, занял ${elapsed}ms`);
  await inflight; // соединение оборвано — fetch реджектится, это ожидаемо
});

test('M10a: во время shutdown новые соединения не принимаются', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise((r) => setTimeout(r, 500));
        return c.text('ok');
      }),
  });

  const inflight = fetch(`http://127.0.0.1:${s.port}/slow`);
  await new Promise((r) => setTimeout(r, 100));

  const closing = s.close();
  await new Promise((r) => setTimeout(r, 100)); // listener уже закрыт, drain идёт

  const refused = await new Promise((resolve) => {
    const sock = net.connect(s.port, '127.0.0.1');
    sock.on('connect', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(true));
  });
  assert.equal(refused, true, 'listener должен быть закрыт до окончания drain');

  await closing;
  assert.equal((await inflight).status, 200, 'запрос в полёте должен дожаться');
});

test('M10a: SIGTERM → graceful shutdown и exit 0', async () => {
  const port = nextPort();
  const child = spawn(process.execPath, [join(here, 'fixtures/sigterm-server.mjs'), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Дожидаемся готовности.
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => (String(d).includes('ready') ? resolve() : null));
      child.on('exit', () => reject(new Error('процесс упал до готовности')));
      setTimeout(() => reject(new Error('сервер не поднялся')), 5000);
    });

    const inflight = fetch(`http://127.0.0.1:${port}/slow`);
    await new Promise((r) => setTimeout(r, 150));
    child.kill('SIGTERM');

    const res = await inflight;
    assert.equal(res.status, 200, 'in-flight запрос должен пережить SIGTERM');
    assert.equal(await res.text(), 'drained');

    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, 'процесс должен выйти с кодом 0');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('M10a: h2 получает GOAWAY на shutdown, текущий стрим дожимается', async () => {
  const http2 = await import('node:http2');
  const s = await up({
    config: { h2c: true },
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise((r) => setTimeout(r, 500));
        return c.text('h2-drained');
      }),
  });

  const client = http2.connect(`http://127.0.0.1:${s.port}`);
  let goaway = false;
  client.on('goaway', () => (goaway = true));

  const body = await new Promise((resolve, reject) => {
    const req = client.request({ ':path': '/slow' });
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (d += chunk));
    req.on('end', () => resolve(d));
    req.on('error', reject);
    req.end();
    // Инициируем shutdown, пока стрим в полёте.
    setTimeout(() => s.close(), 150);
  });

  assert.equal(body, 'h2-drained', 'стрим в полёте должен дожаться');
  assert.equal(goaway, true, 'клиент должен получить GOAWAY');
  client.close();
});
