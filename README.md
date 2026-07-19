# `@oxide/http`

HTTP/1.1 и HTTP/2 сервер для Node.js: сетевой слой, роутинг, валидация и лимиты —
в Rust (hyper + tokio), прикладные хендлеры — на JS/TypeScript.

```ts
import { Server } from '@oxide/http';

const app = new Server();

app.get('/users/:id', (c) => c.json({ id: c.req.params.id }));
app.post('/echo', async (c) => c.json(await c.req.json()));

await app.listen({ port: 3000 });
```

---

## Честно о производительности

Начнём с того, о чём обычно умалчивают.

**На маршрутах, которые уходят в JS-хендлер, эта библиотека медленнее встроенного
`node:http`** — примерно 40k против 69k RPS в наших замерах. Причина архитектурная:
каждый такой запрос пересекает границу napi (вызов ThreadsafeFunction + `Promise`
через границу), и один этот переход стоит ~17 мкс времени главного потока, тогда как
`node:http` обрабатывает весь запрос за ~14.5 мкс. Оптимизация JS-обёртки этот разрыв
не закроет — предел известен и измерен.

**Выигрыш — там, где JS не будится вообще.** Всё перечисленное отвечает из Rust, не
отнимая ни микросекунды у event loop (ELU = 0.000 против 1.0 на JS-маршрутах):

| Что | Эффект |
|---|---|
| Роутинг, `404`, `405` + `Allow`, авто-`HEAD`/`OPTIONS` | не доходит до JS |
| CORS preflight | отвечает Rust |
| Валидация схемы с отказом → `400` | JS не просыпается |
| `413` (лимит тела), `415` (тип), `431` (заголовки), `408` (таймаут чтения) | обрываются на краю |
| `503` при перегрузке + `Retry-After` | до захвата слота |
| `/healthz`, `/readyz`, `/metrics` | отвечают под нагрузкой и при drain'е |

То есть смысл не в «быстрее Node», а в том, что **мусорный и служебный трафик
не доходит до вашего event loop**, а прод-обвязка (graceful shutdown, backpressure,
метрики, лимиты) есть из коробки и работает вне JS.

Подробные числа и методика — [BENCHMARKS.md](BENCHMARKS.md).

---

## Установка

```bash
npm i @oxide/http
# схемы — опционально:
npm i valibot @valibot/to-json-schema
```

Node 18+. Готовые бинарники: linux x64/arm64 (glibc и musl), macOS arm64/x64.
Rust-тулчейн для установки не нужен.

---

## Контекст `c`

Единственный аргумент хендлера.

```ts
app.post('/orders/:id', async (c) => {
  c.req.method;                  // 'POST'
  c.req.path;                    // '/orders/42' (без baseUrl)
  c.req.params.id;               // '42'
  c.req.query.sort;              // last-wins
  c.req.queries('tag');          // все значения
  c.req.header('content-type');  // регистронезависимо
  c.req.ip;                      // с учётом customIpHeaders и PROXY protocol
  c.req.id;                      // UUIDv7, если не пришёл x-request-id
  c.req.cookie('sid');
  c.req.signal;                  // AbortSignal: таймаут/дисконнект

  await c.req.json();            // тело (лимит соблюдается в Rust)
  await c.req.text();
  await c.req.arrayBuffer();
  await c.req.formData();
  c.req.stream;                  // ReadableStream с backpressure
  c.req.parts();                 // multipart, потоково

  c.set('user', user);           // обмен между middleware
  c.get('user');
  c.log.info('сообщение', { extra: 1 });  // JSON-лог с requestId

  c.status(201).header('x-a', 'b');
  c.cookie('sid', 'v', { httpOnly: true, sameSite: 'lax' });
  return c.json({ ok: true });   // либо c.text / c.body / c.redirect / c.notFound
});
```

Возврат значения работает как сахар: объект → `c.json`, строка → `c.text`,
Buffer/поток → `c.body`.

## Маршруты и группы

```ts
app.get(path, handler);
app.get(path, options, handler);          // схемы, multipart, маршрутные хуки
app.get(path, mw1, mw2, handler);         // маршрутные middleware
// post / put / patch / delete / head / options / all — так же

const api = new Server();
api.get('/ping', (c) => c.text('pong'));
app.route('/api/v1', api);                // монтирование под префиксом
```

⚠️ Один параметр на сегмент: `/:id` работает, `/{id}.{ext}` — нет (ограничение
роутера). Обходится матчингом сегмента целиком и разбором в хендлере.

## Middleware и хуки

```ts
app.use(async (c, next) => { await next(); });      // глобальный
app.use('/admin', authMiddleware);                  // по префиксу

app.onRequest(fn);        // до разбора тела
app.preValidation(fn);
app.preHandler(fn);
app.preSerialization(fn); // «после»-хуки идут всегда
app.onSend(fn);           // последняя точка правки заголовков
app.onResponse(fn);       // наблюдение
app.onTimeout(fn);
app.onError((err, c) => c.json({ error: String(err) }, 500));
```

Порядок: `onRequest → preParsing → preValidation → preHandler → [middleware →
хендлер] → preSerialization → onSend → onResponse`. Любой «до»-хук, сформировавший
ответ, обрывает цепочку; «после»-хуки выполняются всегда.

## Схемы

```ts
import * as v from 'valibot';

app.post('/users', {
  schema: {
    body: v.object({ name: v.string(), age: v.number() }),
    query: v.object({ dryRun: v.boolean() }),
    response: { 200: v.object({ id: v.string() }) },   // лишние поля отсекаются
  },
}, (c) => c.json({ id: 'u1', secret: 'не утечёт' }));
```

Структурная часть проверяется в Rust — невалидный запрос получает `400`, не разбудив
JS. `transform`/`check` доигрывает valibot уже в JS. Query и params коэрцируются по
типам из схемы (`?age=42` придёт числом). Принимается и сырой JSON Schema.

Формат ошибки: `{ error: 'validation', issues: [{ in, path, message, code }] }`.

## Тестирование без сокета

```ts
const res = await app.inject({ method: 'POST', path: '/users', body: { name: 'Аня' } });
res.status;      // 400
res.json();
res.headers['content-type'];
res.rawHeaders;  // с повторами (несколько set-cookie)
```

Запрос идёт по in-memory каналу через **тот же** конвейер — роутинг, схемы, CORS,
метрики, луковица. Это не мок.

---

## Конфигурация

```ts
new Server({ /* ... */ });
```

**Базовое:** `baseUrl`, `bodyLimit` (`'10mb'`), `requestTimeout` (`'30s'`),
`requestId.header`, `customIpHeaders`, `customCountryHeaders`.

**Протокол:** `tls: { cert, key }` (PEM-строка, путь или Buffer; ALPN сам согласует
h2/http1.1), `h2c: true` (HTTP/2 prior-knowledge на plaintext-порту),
`http2: { maxConcurrentStreams, initialWindowSize, maxResetStreamsPerSec }`.

**Таймауты и лимиты:** `headerReadTimeout`, `bodyReadTimeout` (→`408`),
`idleTimeout`, `handshakeTimeout`, `maxHeaders`, `maxHeaderSize` (→`431`).

**Жизненный цикл:** `shutdownTimeout` (дефолт `'10s'`), `preShutdownDelay`,
`handleSignals` (SIGTERM/SIGINT по умолчанию включены).

**Сеть:** `backlog`, `reusePort`, `noDelay`, `maxConnections`, `proxyProtocol`,
`workerThreads: число | 'auto'` (авто читает cgroup-квоту пода, а не ядра ноды).

**Наблюдаемость:** `health: { path, readyPath, metricsPath, port }`, `accessLog`.

**Перегрузка:** `maxConcurrentRequests`, `maxQueue`, `queueTimeout`, `retryAfter`,
`overloadShedAfter`.

**CORS:** `cors: { origin, methods, allowedHeaders, exposedHeaders, credentials, maxAge }`.
Preflight отвечает Rust. Динамическая логика origin — обычным JS-middleware.

Единицы принимают и строку (`'10mb'`, `'30s'`), и число (байты, миллисекунды).

---

## Прод: k8s

```ts
const app = new Server({
  preShutdownDelay: '10s',   // снять readiness и ещё принимать, пока LB уводит трафик
  shutdownTimeout: '15s',    // дедлайн drain'а
  health: { port: 9090 },    // пробы и метрики на отдельном порту
  maxConcurrentRequests: 500,
  overloadShedAfter: '5s',
  workerThreads: 'auto',
});

app.setReadinessCheck(async () => db.isConnected(), { interval: 2000 });
```

Манифест — [examples/k8s.yaml](examples/k8s.yaml). Ключевое:
`terminationGracePeriodSeconds` должен быть **больше** `preShutdownDelay + shutdownTimeout`,
иначе k8s убьёт под посреди drain'а.

Последовательность остановки: SIGTERM → `/readyz` отдаёт `503` (под снимается с
эндпоинтов), listener **ещё принимает** `preShutdownDelay` → затем приём прекращается,
h2 получает `GOAWAY`, in-flight дожимается до `shutdownTimeout` → `exit 0`.

## Метрики

`/metrics` в формате Prometheus: `http_requests_total{method,status}` (status —
класс: `2xx`/`4xx`/...), гистограмма `http_request_duration_seconds`,
`http_requests_in_flight`, `http_connections_active`, счётчики байт тел.

---

## Примеры

| Файл | Про что |
|---|---|
| [01-basic.ts](examples/01-basic.ts) | маршруты, параметры, query, cookies |
| [02-schemas.ts](examples/02-schemas.ts) | валидация, коэрция, отсечение полей ответа |
| [03-streaming.ts](examples/03-streaming.ts) | SSE, большие ответы, чтение тела потоком |
| [04-multipart.ts](examples/04-multipart.ts) | загрузка файлов с лимитами |
| [05-middleware.ts](examples/05-middleware.ts) | луковица, хуки, ошибки, группы |
| [06-tls-h2.ts](examples/06-tls-h2.ts) | TLS, ALPN, h2c |
| [k8s.yaml](examples/k8s.yaml) | манифест с пробами и graceful shutdown |

## Чего нет

- **WebSocket** — не поддерживается и не планируется (библиотека про API).
- **Несколько параметров в одном сегменте пути** — ограничение роутера.
- **Динамическая origin-функция в нативном CORS** — пишется JS-middleware.
- **Hot-reload TLS-сертификатов** — фаза 2.
- **Точный код статуса в метриках** — только класс (кардинальность).

## Разработка

```bash
npm run build        # сборка нативного аддона (нужен Rust)
npm test             # 127 тестов, .ts исполняются Node напрямую
npm run typecheck    # tsc для библиотеки и тестов
npm run lint         # clippy + typecheck
node bench/run.mjs   # бенчмарки
```

Исходники JS-слоя — TypeScript в `js/*.ts` (директория `src/` занята Rust-кодом),
сборка в `dist/` (CJS). Подробности решений — [IMPLEMENTATION.md](IMPLEMENTATION.md),
архитектура — [DESIGN.md](DESIGN.md).

## Лицензия

MIT

---

## Сборка из исходников

Готовые бинарники покрывают linux x64/arm64 (glibc и musl) и macOS arm64/x64.
Если вашей платформы нет в списке, соберите сами — нужен Rust:

```bash
git clone https://github.com/saxik/oxide-http && cd oxide-http
npm ci
npm run build:release   # .node под текущую платформу
npm run build:ts        # dist/ (CJS + типы)
node scripts/smoke.cjs  # проверка, что аддон грузится
```

Проверить загрузку в чистом образе можно готовыми Dockerfile'ами:

```bash
docker build -f examples/docker/Dockerfile.ubi9 .     # glibc-бинарник
docker build -f examples/docker/Dockerfile.alpine .   # musl-бинарник
```

Важно: libc аддона обязана совпадать с libc Node. Для Alpine нужен именно
musl-бинарник — glibc-сборка там не загрузится.
