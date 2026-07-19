// Разбор цены перехода границы по слоям (§17). Каждый вариант — свой процесс.
//
//   native  — ответ целиком в Rust, JS не будится вообще (базовая линия)
//   bridge  — RustServer напрямую, колбэк возвращает константу: чистая цена
//             TSFN + Promise + сборки MatchedRequest, без нашей обёртки
//   ctx     — bridge + buildContext (контекст `c` собирается, но луковицы нет)
//   full    — публичный Server со всей обёрткой
//
// Разности между соседями и дают раскладку.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { RustServer } = require(join(here, '../index.js'));
const { Server } = require(join(here, '../js/index.js'));
const { buildContext, buildNativeResponse } = require(join(here, '../js/context.js'));

const variant = process.argv[2];
const port = Number(process.argv[3]);
const PAYLOAD = { hello: 'world', ok: true, n: 42 };
const BODY = JSON.stringify(PAYLOAD);

/** Минимальные опции для сырого RustServer (обёртка обычно заполняет их сама). */
const baseOptions = {
  customIpHeaders: [],
  customCountryHeaders: [],
  requestIdHeader: 'x-request-id',
  bodyLimit: 10 * 1024 * 1024,
};

const JSON_HEADERS = [{ key: 'content-type', value: 'application/json' }];

// Держим ссылки на серверы: без этого V8 соберёт объект, нативный Drop погасит
// рантайм и сервер молча умрёт под нагрузкой. Публичный `Server` от этого защищён
// (колбэк диспетчера захватывает `this`), а сырой `RustServer` — нет.
const alive = [];

const variants = {
  // JS не будится: путь обслуживается нативной ручкой (§11).
  async native() {
    const app = new Server({ health: { path: '/json' } });
    alive.push(app);
    await app.listen({ port, host: '127.0.0.1' });
  },

  // Граница есть, обёртки нет: колбэк сразу отдаёт готовый ответ.
  async bridge() {
    const native = new RustServer();
    alive.push(native);
    native.listen(
      port,
      '127.0.0.1',
      [{ method: 'GET', path: '/json', leafId: 0 }],
      false,
      baseOptions,
      () => Promise.resolve({ status: 200, headers: JSON_HEADERS, body: BODY }),
    );
  },

  // Только ЧТЕНИЕ полей napi-объекта, без всякой логики: отделяет цену доступа
  // к данным через границу от цены нашего JS-кода.
  async touch() {
    const native = new RustServer();
    alive.push(native);
    native.listen(
      port,
      '127.0.0.1',
      [{ method: 'GET', path: '/json', leafId: 0 }],
      false,
      baseOptions,
      ([req]) => {
        let sink = 0;
        for (const { key, value } of req.headers) sink += key.length + value.length;
        for (const { key, value } of req.query) sink += key.length + value.length;
        sink += req.method.length + req.path.length + req.ip.length + req.id.length;
        sink += req.ips.length + (req.country ? 1 : 0) + (req.validBody ? 1 : 0);
        if (sink < 0) throw new Error('недостижимо');
        return Promise.resolve({ status: 200, headers: JSON_HEADERS, body: BODY });
      },
    );
  },

  // Граница + сборка контекста `c`, но без цепочки middleware/хуков.
  async ctx() {
    const native = new RustServer();
    alive.push(native);
    native.listen(
      port,
      '127.0.0.1',
      [{ method: 'GET', path: '/json', leafId: 0 }],
      false,
      baseOptions,
      ([req, bodyIo]) => {
        const c = buildContext(req, bodyIo, {
          baseUrl: '',
          requestIdHeader: 'x-request-id',
          bodyLimit: 10 * 1024 * 1024,
          responseStrip: null,
        });
        c.json(PAYLOAD);
        return Promise.resolve(buildNativeResponse(c));
      },
    );
  },

  // Полный публичный путь.
  async full() {
    const app = new Server();
    alive.push(app);
    app.get('/json', (c) => c.json(PAYLOAD));
    await app.listen({ port, host: '127.0.0.1' });
  },
};

const start = variants[variant];
if (!start) {
  console.error(`неизвестный вариант: ${variant}`);
  process.exit(2);
}
await start();

// Загрузка главного потока: показывает, упирается ли вариант в event loop.
// native должен давать ~0 (JS не будится), путь с JS — приближаться к 1.0.
if (process.env.OXIDE_BENCH_ELU) {
  const { performance } = await import('node:perf_hooks');
  let last = performance.eventLoopUtilization();
  setInterval(() => {
    const cur = performance.eventLoopUtilization();
    console.log(`ELU=${performance.eventLoopUtilization(cur, last).utilization.toFixed(3)}`);
    last = cur;
  }, 2000);
}

console.log('ready');
