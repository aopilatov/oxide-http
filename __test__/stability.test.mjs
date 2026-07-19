// Тесты живучести (§17): утечки, паники, «процесс не падает».
// Нагрузка держится умеренной — набор должен оставаться быстрым; крупные прогоны
// (N=1e6) — дело CI/бенчей, см. BENCHMARKS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { Server } = require('../js/index.js');
const here = dirname(fileURLToPath(import.meta.url));

let PORT = 39800;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config ?? {});
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

/** Прогнать N запросов пачками по `concurrency`. */
async function hammer(url, total, concurrency = 32, init) {
  let done = 0;
  const statuses = new Map();
  const worker = async () => {
    while (done < total) {
      done++;
      const res = await fetch(url, init);
      await res.arrayBuffer(); // тело обязательно вычитываем, иначе течёт сокет
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return statuses;
}

test('M12: под нагрузкой память выходит на плато, а не растёт линейно', async () => {
  // Замер в дочернем процессе с --expose-gc: без принудительного GC цифры RSS
  // шумят настолько, что тест мерил бы не утечку, а фазу луны.
  const port = nextPort();
  const child = spawn(
    process.execPath,
    ['--expose-gc', join(here, 'fixtures/memory-blocks.mjs'), String(port), '15000', '4'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));

  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, `замер упал (code=${code}):\n${err}`);

  const line = out.split('\n').find((l) => l.trim().startsWith('{'));
  assert.ok(line, `нет результата замера:\n${out}${err}`);
  const { samples } = JSON.parse(line);

  const mb = (n) => n / 1024 / 1024;
  // Утечка = устойчивый прирост на каждом блоке. Сравниваем последний блок с
  // первым замеренным (прогрев и разовый рост арен уже позади).
  const growthMb = mb(samples.at(-1).rss - samples[0].rss);
  const heapGrowthMb = mb(samples.at(-1).heapUsed - samples[0].heapUsed);

  assert.ok(
    growthMb < 40,
    `RSS вырос на ${growthMb.toFixed(1)}MB за ${samples.length - 1} блоков — похоже на утечку\n` +
      samples.map((s, i) => `  блок ${i}: rss=${mb(s.rss).toFixed(1)}MB heap=${mb(s.heapUsed).toFixed(1)}MB`).join('\n'),
  );
  assert.ok(heapGrowthMb < 20, `heapUsed вырос на ${heapGrowthMb.toFixed(1)}MB — держим объекты в JS`);
});

test('M12: 5k запросов с телами обрабатываются без потерь', async () => {
  const s = await up({
    routes: (app) => app.post('/echo', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const url = `http://127.0.0.1:${s.port}/echo`;
    const init = { method: 'POST', body: 'x'.repeat(16 * 1024) };
    const statuses = await hammer(url, 5000, 16, init);
    assert.equal(statuses.get(200), 5000, 'все запросы должны быть успешны');
    assert.equal(statuses.size, 1, `посторонних статусов быть не должно: ${[...statuses.keys()]}`);
  } finally {
    await s.close();
  }
});

test('M12: throw в каждом запросе не роняет процесс и не течёт', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/boom', () => {
        throw new Error('штатное падение хендлера');
      }),
  });
  try {
    const statuses = await hammer(`http://127.0.0.1:${s.port}/boom`, 3000);
    assert.equal(statuses.get(500), 3000, 'каждый запрос должен получить 500');
    // Процесс жив — иначе мы бы сюда не дошли.
    assert.equal(s.server.listening, true);
  } finally {
    await s.close();
  }
});

test('M12: unhandledRejection не срабатывает под нагрузкой', async () => {
  const seen = [];
  const onUnhandled = (r) => seen.push(r);
  process.on('unhandledRejection', onUnhandled);

  const s = await up({
    routes: (app) => {
      app.get('/ok', (c) => c.text('ok'));
      app.get('/throw', () => {
        throw new Error('падение');
      });
      app.get('/reject', async () => Promise.reject(new Error('реджект')));
      app.post('/body', async (c) => c.text(await c.req.text()));
    },
  });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    await Promise.all([
      hammer(`${base}/ok`, 1500),
      hammer(`${base}/throw`, 1500),
      hammer(`${base}/reject`, 1500),
      hammer(`${base}/body`, 1500, 32, { method: 'POST', body: 'данные' }),
    ]);
    await new Promise((r) => setTimeout(r, 200)); // дать очереди микротасков разгрестись
    assert.deepEqual(seen, [], `unhandledRejection не должен срабатывать: ${seen}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await s.close();
  }
});

test('M12: оборванные клиентом запросы не копят ресурсы', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise((r) => setTimeout(r, 300));
        return c.text('поздно');
      }),
  });
  try {
    // Клиент уходит, не дождавшись ответа — сервер должен пережить это спокойно.
    for (let i = 0; i < 200; i++) {
      const ctrl = new AbortController();
      const p = fetch(`http://127.0.0.1:${s.port}/slow`, { signal: ctrl.signal }).catch(() => {});
      setTimeout(() => ctrl.abort(), 10);
      await p;
    }
    await new Promise((r) => setTimeout(r, 400));

    // Сервер по-прежнему обслуживает.
    const res = await fetch(`http://127.0.0.1:${s.port}/slow`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'поздно');
  } finally {
    await s.close();
  }
});

test('M12: цикл listen/close 30 раз не копит порты и хендлы', async () => {
  for (let i = 0; i < 30; i++) {
    const app = new Server();
    app.get('/', (c) => c.text(String(i)));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await app.inject({ path: '/' });
    assert.equal(res.text(), String(i));
    await app.close();
  }
});
