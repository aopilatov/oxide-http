# HTTP/HTTP2-сервер для Node.js на Rust — дизайн-документ

Статус: черновик v1 (согласован по ключевым решениям)
Дата: 2026-07-03

## 1. Цель

Быстрый HTTP/1.1 + HTTP/2 сервер для Node.js, реализованный как **нативный аддон на Rust**
(napi-rs). Протокол, TLS, парсинг и роутинг живут в Rust и параллелятся по всем ядрам;
в JS остаётся только прикладная логика (async API-хендлеры и middleware). Целевой профиль
нагрузки — **I/O-bound JSON-API** (БД, внешние сервисы), без серверного рендеринга.
Разворачивается в **Kubernetes**.

## 2. Ключевые решения (сводка)

| # | Решение | Выбор |
|---|---|---|
| 0 | Имя | Пакет **`@oxide/http`**, класс **`Server`** |
| 1 | Интеграция с Node | Нативный аддон (**napi-rs**), `.node` в процессе Node |
| 2 | Публичный API | Свой минималистичный (Hono-подобный), **не** drop-in `node:http` |
| 3 | TLS | Терминируется в Rust (**rustls**), ALPN → h2 / http1.1 |
| 4 | Async-хендлеры | Да (возврат `Promise`, `await` результата на мосту) |
| 5 | Параллелизм JS | **Один** JS-поток (event loop). Масштаб — репликами в k8s, ~1 vCPU/под |
| 6 | Роутинг | В Rust на **`matchit`** (radix-tree) |
| 7 | Возможности роутера | static, `:param`, catch-all в конце. **Нет**: mid-path wildcard, опциональные, regex-constraints, несколько параметров в сегменте (ограничение matchit — см. §5) |
| 8 | Middleware | «Луковица» с `next()` (код до и после), управляется из Rust |
| 9 | Контекст `c` | Каноничен **в JS** (обычный объект), `set/get`/`c.res` без пересечения границы |
| 10 | Нативные middleware v1 | **body-limit + cors + timeout**. compression → фаза 2 |
| 11 | Привязка middleware | Глобальные + по префиксу + маршрутные + группы. **Предкомпиляция** цепочек на `listen()` |
| 12 | Ошибки | `try/catch` вокруг `next()`; непойманное → `app.onError` → дефолтный 500; `catch_unwind` на границах; процесс не падает никогда |
| 13 | Контракт ответа | `c.json/c.text/c.status/c.header` (осн.) + возврат значения как сахар |
| 14 | Тело запроса/ответа | **Стриминг** в обе стороны с backpressure |
| 15 | Форма стримов | **Web Streams** (`ReadableStream`/`WritableStream`) + адаптеры к Node-стримам |
| 16 | Graceful shutdown | Rust ловит SIGTERM/SIGINT, drain с дедлайном, `GOAWAY` для h2, ждёт in-flight (вкл. JS), событие `shutdown` + `await server.close()` |
| 17 | Health / observability | `/healthz`+`/readyz` в Rust (+ JS readiness-колбэк), `/metrics` Prometheus, JSON-лог в stdout |
| 18 | Конфигурация | Единый конфиг-объект; TLS путь/Buffer; multi-port (health/metrics отдельно) |
| 19 | h2c | Prior-knowledge cleartext HTTP/2 (для mesh/LB) |
| 20 | Сборка/доставка | napi-rs CLI, prebuild в npm, baseline glibc 2.17 + musl, x64/arm64. Node 18+ (N-API 8) |

## 3. Архитектура: путь одного запроса

```
   сеть
    │
    ▼
┌─────────────────────────── RUST (пул потоков tokio, все ядра) ───────────────────────────┐
│ 1. accept → rustls (TLS + ALPN) → hyper (HTTP/1.1 | HTTP/2 | h2c prior-knowledge)         │
│ 2. matchit: маршрут + params.  Нет → 404/405 в Rust (или app.notFound)                     │
│ 3. нативные middleware на краях: cors preflight / body-limit / timeout — могут прервать    │
│ 4. предкомпилированная цепочка слотов для этого листа маршрута                             │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │ ThreadsafeFunction (один переход/запрос)
                                             │ передаём: method, path, params, headers,
                                             │ bodyLimit, дескриптор потока тела
                                             ▼
┌─────────────────────────── JS (один event loop, libuv) ───────────────────────────────────┐
│ 5. строим c → прогоняем луковицу JS-middleware + хендлер (async)                            │
│    try/catch вокруг всего → app.onError.  Backpressure стрима через Web Streams             │
│ 6. resolve(Promise) с готовым c.res: статус, заголовки, тело (Buffer | ReadableStream)      │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │ JS Promise ↔ Rust Future (await без блокировки)
                                             ▼
┌─────────────────────────── RUST ──────────────────────────────────────────────────────────┐
│ 7. пишем ответ в hyper; для стрима тянем чанки из JS по мере разгрузки сокета              │
│    «после-next» нативные middleware (compression — фаза 2)                                  │
│ 8. метрики (латентность, код, размер) — считаются в Rust почти бесплатно                    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Примитивы napi-rs: **`ThreadsafeFunction`** (Rust→JS из любого tokio-потока),
**интеграция JS-`Promise` ↔ Rust-`Future`**, собственный **`tokio`-рантайм** внутри аддона
(параллельно libuv event loop). JS всегда на потоке libuv; весь Rust-I/O — на потоках tokio.

## 4. Публичный JS API (эскиз)

```js
import { Server } from '@oxide/http';

const app = new Server({
  baseUrl: '/api/v1',               // глобальный префикс всех маршрутов приложения (health/metrics НЕ наследуют)
  customIpHeaders: ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'],  // c.req.ip из первого заполненного
  customCountryHeaders: ['cf-ipcountry', 'x-country-code'],  // c.req.country из первого заполненного
  tls: { cert: './cert.pem', key: './key.pem' },  // путь или Buffer/PEM; нет tls → plaintext
  http1: true,
  h2c: false,                       // prior-knowledge cleartext h2 на plaintext-порту
  bodyLimit: '10mb',
  maxHeaderSize: '16kb',
  requestTimeout: '30s',
  headerReadTimeout: '10s',         // A2: пока читаются заголовки (Slowloris)
  bodyReadTimeout: '30s',           // A2: пока читается тело
  idleTimeout: '60s',               // A2: простой на keep-alive соединении
  keepAliveTimeout: '75s',
  shutdownTimeout: '30s',           // < terminationGracePeriodSeconds пода
  workerThreads: 'auto',            // A3: потоки tokio; 'auto' = учёт cgroup CPU-квоты пода, не ядер ноды
  proxyProtocol: false,             // A4: PROXY protocol v1/v2 от L4-LB (AWS NLB) → реальный peer-IP
  maxConcurrentRequests: 500,       // C5: лимит in-flight; сверх — 503 + readiness not-ready (см. ниже)
  maxQueue: 0,                      // C5: очередь ожидания слота (0 = без очереди, сразу 503)
  queueTimeout: '1s',               // C5: сколько ждать слот в очереди до 503
  socket: { noDelay: true, reusePort: false, backlog: 1024, maxConnections: null },  // B9
  requestId: { header: 'x-request-id', generate: 'uuidv7' },  // B2: генерим, если нет; кладём в c
  http2: {
    enabled: true, maxConcurrentStreams: 250, initialWindowSize: '1mb',
    maxResetStreamsPerSec: 100,     // A1: защита от Rapid Reset (CVE-2023-44487)
  },
  health:  { liveness: '/healthz', readiness: '/readyz' },
  metrics: { enabled: true, path: '/metrics', port: 9090 },  // отдельный порт
  logger:  { format: 'json' },      // B3: c.log с request-id
});

// middleware (луковица)
app.use(async (c, next) => {              // глобальный
  const t = performance.now();
  await next();
  c.res.headers.set('x-time', String(performance.now() - t));
});
app.use('/admin/*', authMiddleware);      // по префиксу

// маршруты (+ маршрутные middleware)
app.get('/users/:id', validate, (c) => c.json({ id: c.req.params.id }));
app.post('/users', async (c) => {
  const body = await c.req.json();
  return c.json({ created: body }, 201);   // возврат значения = сахар над c.json
});

// группы / суб-приложения
app.route('/api/v1', apiV1);

// ошибки и 404
app.onError((err, c) => c.json({ error: err.message }, 500));
app.notFound((c) => c.json({ error: 'not found' }, 404));  // опц., иначе 404 в Rust

// readiness-колбэк (Rust дёргает его на /readyz)
app.setReadinessCheck(async () => db.isConnected());

// жизненный цикл
app.on('shutdown', async () => { await db.close(); });
await app.listen({ port: 3000, host: '0.0.0.0' });
```

## 5. Роутинг

- Движок — **`matchit` 0.8** (radix-tree). Матчинг и разбор `params` в Rust.
- Поддерживается: static; `:param` (один сегмент); catch-all в конце (`/static/*path`);
  приоритет static над param (авто).
- **Не** поддерживается: mid-path wildcard, опциональные параметры, regex-constraints,
  а также **несколько параметров в одном сегменте** (`/{id}.{ext}`) — жёсткое ограничение
  matchit 0.8 («один параметр на сегмент»). Обход: матчить сегмент целиком (`/:name`) и
  делить в хендлере. Опциональность → два маршрута; формат `:id` → валидация в хендлере.
  <!-- M2: правка относительно черновика — matchit не умеет multi-param per segment. -->
- Публичный синтаксис — Hono-подобный (`:id`, `*path`); внутри транслируется в
  matchit-синтаксис (`{id}`, `{*path}`). Форма `{id}` также принимается как есть.
- Методы: `get/post/put/patch/delete/head/options` + `all`.
- 404/405 отдаёт Rust без пробуждения JS (если не задан `app.notFound`).
- **`baseUrl`** (глобальный префикс, напр. `/api/v1`): приклеивается ко всем маршрутам **при регистрации** (в предкомпиляции дерева, рантайм без накладных); складывается с групповыми префиксами (`baseUrl` + `app.route(prefix)` + маршрут).
  - `c.req.path` — **без** префикса (`/users/42`), полный доступен как `c.req.url`/`c.req.rawPath` → хендлеры не зависят от точки монтирования.
  - **Health/metrics — абсолютные**, префикс не наследуют (пробы k8s бьют по `/healthz` и т.п.; могут жить на отдельном порту).
  - Нормализация значения: ведущий слэш обязателен, хвостовой убирается; пустой/`'/'` = без префикса.

## 6. Middleware (луковица)

- Модель Koa/Hono: `(c, next) => { /* до */ await next(); /* после */ }`.
- Цепочка **предкомпилируется на `listen()`**: для каждого листа роутера заранее строится
  финальный упорядоченный список слотов (нативные Rust + JS), в рантайме — просто исполняется.
- Слот бывает **нативный (Rust)** или **JS**. Подряд идущие JS-слоты Rust отдаёт в JS одним
  куском → один переход границы на запрос (а не 2×N).
- Нативные middleware работают на **краях** луковицы (не видят `c.set('user')`, т.к. контекст в JS).
- Источники цепочки: глобальные `app.use(mw)` + префиксные `app.use('/p/*', mw)` +
  маршрутные `app.get(path, ...mw, handler)` + группы `app.route(prefix, sub)`; порядок — по регистрации.

## 6a. Жизненный цикл запроса и хуки (Fastify-стиль поверх луковицы)

Именованные хуки жизненного цикла; на каждое событие можно навесить **массив** обработчиков.
Часть хуков физически в Rust — без JS-подписки они отрабатывают в Rust, event loop спит.

**Полный конвейер одного запроса (сверху вниз):**

```
onConnect            (Rust)  новое TCP/TLS-соединение (на соединение, не на запрос)
─────────────────────────────────────────────────────────────────
[ нативный cors: preflight OPTIONS ]  (Rust, ДО onRequest — JS не будится вовсе)
onRequest            (JS)    заголовки распарсены, ДО роутинга (ранний rate-limit/auth)
[ matchit: маршрут ]         нет → notFound (Rust, либо app.notFound в JS)
[ нативные-вход: cors(origin-check) → body-limit → timeout(старт дедлайна) ]  (Rust)
preParsing           (JS)    перед чтением тела (можно подменить поток)
[ чтение тела с учётом bodyLimit + входящая декомпрессия (B5) ]
preValidation        (Rust+JS) A6: Rust структурно по JSON Schema (вне loop) → 400; затем JS-valibot доигрывает transform/refine
preHandler           (JS)    тело доступно и валидно, перед луковицей+хендлером
┌── ЛУКОВИЦА middleware: before → ХЕНДЛЕР → after ──┐
└───────────────────────────────────────────────────┘
preSerialization     (JS)    перед сериализацией результата в байты
onSend               (JS)    ответ сформирован, перед записью (нативные-выход: cors-заголовки; compression — фаза 2)
[ запись в сокет ]           (Rust)
onResponse           (Rust)  обработка завершена (не обяз. успешно отправлено); лог/метрики/очистка
onClose              (Rust)  соединение закрыто
─────────────────────────────────────────────────────────────────
ИСКЛЮЧЕНИЯ (в любой момент):
onError   (JS)   единый: наблюдение + формирование ответа; нет ответа → 500
onTimeout (Rust) дедлайн истёк → signal abort → хуки → c.res или дефолт 504
onAbort   (Rust) клиент отвалился до ответа → signal abort → хуки → финализация
```

**Семантика (согласовано):**
- Обработчики события — **последовательно** в порядке регистрации, каждый `async`, `await`-ится по очереди.
- **Short-circuit:** хук сформировал `c.res`/вернул ответ → конвейер прерывается, хендлер пропускается, но `onSend`/`onResponse` выполняются всегда.
- Единый **`c`** на весь жизненный цикл (`set/get`, `c.req`, `c.res`).
- Любой `throw`/reject в любом хуке → единый **`onError`** (формирует ответ; несколько обработчиков — последовательно, итоговый `c.res` уходит клиенту; нет ответа → 500).
- **«После»-хуки** (`onSend`/`onResponse`) идут **всегда** (ошибка/прерывание/таймаут/дисконнект) — гарантия лог/метрик/очистки. `onResponse` — только наблюдение.
- **Scope:** глобальные + групповые (инкапсуляция, как в Fastify — не «протекают») + маршрутные. Цепочки на стадию **предкомпилируются на `listen()`**. Порядок сборки: глоб → групп → маршрут, по регистрации (без разворота для «после»).
- **API:** именованные методы `app.onRequest(fn)`, `app.preHandler(fn)`, … (осн.) + `app.addHook(name, fn)` (обобщённый). Маршрутные — через опции: `app.get('/x', { onRequest:[...], preHandler:[...] }, handler)`.
- **Rust-level хуки без подписки не будят JS**; с подпиской — async-хендлер дожидается (in-flight учитывается graceful shutdown'ом).
- **Нативные middleware вход/выход:** cors — preflight `OPTIONS` в Rust до `onRequest` (JS не будится) + origin-check на входе + `Access-Control-*` заголовки на `onSend`; body-limit — только вход (`413`); timeout — вход (старт дедлайна) → ветка `onTimeout`.

**Отмена (таймаут / дисконнект):**
- `c.req.signal` — стандартный `AbortSignal`, срабатывает при таймауте **или** дисконнекте (передавать в `fetch`/драйвер БД для кооперативной отмены). Срабатывает максимум один раз.
- **Таймаут:** signal abort → `onTimeout` → `c.res` или дефолт **504**; запоздавший результат хендлера отбрасывается без ошибки.
- **Дисконнект:** signal abort → `onAbort` → финализация; отправлять некуда, результат отбрасывается.
- Флаги в `c` для «после»-хуков: `c.res.sent`, `c.aborted` — различать успех/дисконнект/таймаут.
- Терминальное событие ровно одно: `onResponse` **или** `onAbort` **или** таймаут-ветка — не пересекаются.

## 6b. Схемы запроса/ответа (A6, valibot → JSON Schema → нативный Rust)

Источник истины — **valibot** (типы через `v.InferOutput`); принимаем и «сырой» JSON Schema.
zod/arktype (Standard Schema) через их `toJsonSchema` — фаза 2.

```js
import * as v from 'valibot';
const CreateUser = v.object({ name: v.pipe(v.string(), v.minLength(2)), age: v.pipe(v.number(), v.minValue(0)) });

app.post('/users', {
  schema: { body: CreateUser, query: v.object({ ref: v.optional(v.string()) }), response: { 200: UserOut } },
}, (c) => c.json(c.req.valid('body')));   // c.req.valid('body'|'query'|'params') — типизировано
```

- **На `listen()`**: valibot → JSON Schema (`@valibot/to-json-schema`) → Rust компилирует валидатор
  (`jsonschema`) и быстрый сериализатор ответа (аналог `fast-json-stringify`).
- **Слоёная валидация:** Rust — структурно (типы/required/min-max/enum/pattern/format) **вне event loop** → `400`;
  затем JS-valibot доигрывает `transform`/кастомные `check` над структурно-валидными данными (стадия `preValidation`).
- **Коэрция** query/params (всегда строки): Rust приводит по схеме (`?age=42` → number).
- **Ответ:** нативная сериализация по схеме + **отсечение лишних полей** (не утечёт то, чего нет в схеме);
  валидация ответа — только в **dev**, в prod просто сериализуем.
- **Ошибки валидации:** `400` + машиночитаемый `[{ path, message, code }]`; переопределяемо в `onError`/спец-хуке.

## 6c. Безопасность и сеть (A1–A4, B9, B10)

- **A1 HTTP/2 Rapid Reset (CVE-2023-44487):** лимит reset-стримов (`http2.maxResetStreamsPerSec`), защита от DoS.
- **A2 Таймауты чтения** (против Slowloris): `headerReadTimeout`, `bodyReadTimeout`, `idleTimeout` — отдельно от `requestTimeout`.
- **A3 tokio worker-threads vs CPU-квота:** `workerThreads: 'auto'` читает cgroup CPU-квоту пода (не число ядер ноды),
  чтобы не оверпровижнить при лимите ~1 vCPU. Можно задать число явно.
- **A4 PROXY protocol v1/v2:** за L4-LB (AWS NLB) реальный peer-IP берётся из PROXY-префикса на сокете (socket-level).
  Складывается с `customIpHeaders` (сначала снимаем PROXY, потом смотрим заголовки).
- **B9 Socket-опции:** `TCP_NODELAY` (латентность API, вкл. по умолчанию), `SO_REUSEPORT`, `backlog`, `maxConnections`;
  прослушивание **Unix-сокета** (`listen({ path })`).
- **B10 HTTP-корректность:** авто-`HEAD` (как GET без тела), авто-`OPTIONS`, `405` + заголовок `Allow`,
  `431 Request Header Fields Too Large` при превышении `maxHeaderSize`, `501` на неизвестный метод.
- **C5 `maxConcurrentRequests` (защита от перегрузки + разгрузка через k8s):** in-flight считаем в Rust.
  Реальность: обычный Service (kube-proxy) не умеет per-request «отдать другому поду» — только косвенно.
  **Двухслойно:**
  1. **Мгновенный `503`** сверх жёсткого лимита (`+ Retry-After`, для h2 — `GOAWAY`, чтобы клиент переоткрылся
     на другой под); за retry-способным ingress/mesh (nginx/Envoy/Istio) запрос «переезжает» без ошибки у клиента.
  2. **Readiness → not-ready** при устойчивой перегрузке → k8s убирает под из эндпоинтов (новые соединения уходят).
     Замечание: readiness влияет только на **новые соединения**; уже открытое h2-соединение шлёт стримы на тот же под,
     поэтому слой 1 (`503`/`GOAWAY`) для h2 важнее.
  - **Очередь** (`maxQueue`, дефолт 0 = без): краткий всплеск ждёт слот до `queueTimeout`, затем `503`.
- **WebSocket — НЕ поддерживаем** (только API); архитектуру под upgrade не закладываем.

## 6d. DX / API-дополнения (группа B)

- **B1 Cookies:** `c.req.cookie(name)` (парсинг) + `c.cookie(name, val, { httpOnly, secure, sameSite, maxAge, path, domain })`;
  подписанные/шифрованные — фаза 2 (через `Set-Cookie` отдельными строками, см. §модель заголовков).
- **B2 Request ID:** если нет `x-request-id` — генерируем **UUIDv7**; кладём в `c.req.id`, пробрасываем в ответ.
- **B3 Контекстный логгер `c.log`:** структурный JSON с `requestId` в каждой записи.
- **B4 urlencoded:** `application/x-www-form-urlencoded` → `await c.req.formData()`/`c.req.parseBody()`.
- **B5 Входящая декомпрессия:** `Content-Encoding: gzip/br` на запросе — распаковка в Rust (с учётом `bodyLimit` по распакованному).
- **B6 Response-хелперы:** `c.redirect(url, code=302)`, `c.notFound()`, SSE — `c.streamSSE(cb)` поверх Web Streams.
- **B7 Server-события:** `app.on('listening'|'error'|'close', ...)`; при неудачном bind (EADDRINUSE) — reject `listen()` с явной ошибкой.
- **B8 `app.inject(req)`:** тест-харнесс без реального сокета (быстрые интеграционные тесты).

## 7. Контекст `c` (в JS)

- `c.req` — `method`, `path`, `params`, `query`, `headers`, тело: `c.req.stream` (Web `ReadableStream`),
  `await c.req.json()` / `.text()` / `.arrayBuffer()` (буферизуют до `bodyLimit`).
- `c.req.ip` / `c.req.ips` — клиентский IP (вычисляется в **Rust**): идём по `customIpHeaders` по порядку,
  берём первый присутствующий и непустой заголовок; `X-Forwarded-For`-цепочку (`client, proxy1, ...`)
  разбиваем по запятым — `ip` = первый (левый) элемент с trim'ом, `ips` = весь массив. Ни один не заполнен
  или список не задан → **peer-адрес TCP-сокета** (`ip` есть всегда).
  ⚠️ Доверять forwarded-заголовкам безопасно **только за доверенным прокси**; trust-proxy CIDR — фаза 2.
- `c.req.country` — страна клиента (Rust): первый заполненный из `customCountryHeaders`, trim + uppercase
  (ISO 3166-1 alpha-2; спецзначения Cloudflare `XX`/`T1` — как есть). Нет источника → `undefined`.
  Серверный GeoIP по IP — фаза 2.
- `c.set(k, v)` / `c.get(k)` — обмен данными между middleware (чистый JS, бесплатно).
- `c.res` — мутабельный: `c.status(n)`, `c.header(k, v)`, `c.res.headers` (правится и «после next»).
- Хелперы ответа: `c.json(v, status?)`, `c.text(v, status?)`, `c.body(bufferOrStream, status?)`.

## 8. Обработка ошибок (жёсткий инвариант: процесс не падает)

- Каждый вызов JS с моста обёрнут: синхронный `throw` и `reject` Promise → ошибка для `onError`.
- JS-слой оборачивает всю луковицу в общий `try/catch` → любое исключение доходит до `app.onError(err, c)`.
- Локальный `try/catch` вокруг `await next()` в middleware работает естественно (обработать самому).
- Если `app.onError` сам бросит → последний рубеж: дефолтный 500 + лог.
- Rust: `catch_unwind` на всех границах; паника → 500, процесс жив.
- Страховочный process-level `unhandledRejection`-хендлер с явным логом (в норме не срабатывает; срабатывание = баг обёртки).

## 9. Стриминг (Web Streams, backpressure через мост)

- **Запрос**: `c.req.stream` — Web `ReadableStream`; `for await (const chunk of ...)`.
  Backpressure: JS сигналит Rust «готов принять ещё».
- **Ответ**: `c.body(new ReadableStream(...))` или async-iterable (сахар). Backpressure: Rust
  сигналит JS «сокет разгрузился». Кейсы: SSE, крупные выгрузки/загрузки, проксирование.
- Совместимость с Node-стримами — через `Readable.fromWeb`/`toWeb`.

## 9a. Multipart (`multipart/form-data`, загрузка файлов) — опция маршрута

Включается **per-route**; парсинг — в **Rust** (потоковый `multer`), вне event loop.

```js
app.post('/upload', {
  multipart: {                       // true = дефолтные лимиты; объект = переопределение
    maxFileSize: '50mb', maxFiles: 10, maxFields: 100, maxFieldSize: '1mb',
    allowedMimeTypes: ['image/*', 'application/pdf'],   // wildcard поддерживается
    allowedExtensions: ['.png', '.jpg', '.jpeg', '.pdf'],
  }
}, async (c) => {
  for await (const part of c.req.parts()) {            // A: потоково (основной)
    if (part.filename) await uploadToS3(part.stream);  // part: { name, filename?, contentType?, stream }
    else fields[part.name] = await part.text();
  }
  // либо B (сахар для мелких форм): const form = await c.req.formData();  // Web FormData, всё в память
});
```

- **Content-Type не `multipart/form-data`** при включённом флаге → `415`.
- **Отдача в JS:** основной — `c.req.parts()` (async-итератор, файл = Web `ReadableStream`, backpressure через мост);
  сахар — `c.req.formData()` (Web `FormData`, в память, под защитой `maxFileSize`).
- **Лимиты (per-route, дефолты из глобального конфига):** `maxFileSize`→`413`, `maxFiles`/`maxFields`→`400`,
  `maxFieldSize`. Прерывание в Rust до передачи в JS, где возможно.
- **Ограничение типов (только к частям с `filename`):** `allowedMimeTypes` (по `Content-Type` части, wildcard `image/*`)
  **и** `allowedExtensions` (по `filename`); нарушение → **`415`**, до вычитывания файла. Обе проверки в Rust.
- **Диск не трогаем** (без автозаписи temp-файлов) — только потоки/буферы. Helper `saveTo(path)` — фаза 2.

## 10. Жизненный цикл / graceful shutdown (k8s)

1. SIGTERM/SIGINT ловит Rust. 2. Закрывает listener (нет новых соединений).
3. Readiness → «не готов» (k8s уводит трафик). 4. Ждёт in-flight (вкл. JS-хендлеры), h2 → `GOAWAY`.
5. Дедлайн `shutdownTimeout` (< `terminationGracePeriodSeconds`) → форс-разрыв остатков.
6. Событие `shutdown` в JS (закрыть пул БД и т.п.), `await server.close()`. 7. Выход с кодом 0.
- Опционально: JS может перехватить сигнал сам.

## 11. Health / observability

- `/healthz` (liveness) — Rust отвечает мгновенно, JS не будится.
- `/readyz` (readiness) — Rust; учитывает shutdown и опциональный `app.setReadinessCheck()` (спрашивает JS).
- `/metrics` — Prometheus из Rust: RPS, латентности (гистограммы), коды, соединения/стримы, размеры. Выключаемо.
- Структурный JSON-лог в stdout.
- Health/metrics можно вынести на **отдельный порт** (не светить наружу).
- Опц. (фаза 2): проброс `traceparent` (W3C Trace Context).

## 12. TLS и протоколы

- **rustls**; сертификаты — путь к файлу или Buffer/PEM-строка.
- TLS-порт: ALPN согласует **h2** / **http/1.1**.
- Plaintext-порт: **http/1.1** и/или **h2c prior-knowledge** (по флагам конфига). h2c upgrade не поддерживаем.
- Фаза 2: hot-reload сертификатов (cert-manager / ротация Let's Encrypt).

## 13. Сборка и доставка

- Тулинг: **`@napi-rs/cli`** (кросс-компиляция, `.d.ts`, platform-пакеты, prebuild-публикация).
- **N-API 8** (Node 18+): один бинарник на все версии Node (ABI-стабильно).
- libc аддона обязан совпадать с libc Node → публикуем несколько вариантов, загрузчик выбирает
  через `detect-libc` + `optionalDependencies`.
- glibc-варианты собираются в **docker-образах napi-rs** против baseline **glibc 2.17** (manylinux2014)
  → работают на **Ubuntu / UBI 8/9/10 / Debian / Amazon Linux / RHEL**.

Матрица (приоритет ↓):

| Триплет | Покрытие | Приоритет |
|---|---|---|
| `x86_64-unknown-linux-gnu` (baseline 2.17) | Ubuntu, **UBI 9/10**, Debian, AmazonLinux — x64 | 1 |
| `aarch64-unknown-linux-gnu` (baseline) | то же на ARM64 / Graviton | 1 |
| `x86_64-unknown-linux-musl` | Alpine x64 | 2 |
| `aarch64-unknown-linux-musl` | Alpine ARM64 | 2 |
| `aarch64-apple-darwin` | локальная разработка (Mac M-серия) | dev |
| `x86_64-apple-darwin` | Mac Intel | опц. |
| `x86_64-pc-windows-msvc` | Windows-разработка | опц. |

- Доставка: prebuild в npm (основной `@oxide/http` + `@oxide/http-linux-x64-gnu` и т.д. в `optionalDependencies`).
  В Docker-образ Rust-тулчейн не нужен — `npm ci` тянет готовый бинарник.

## 14. Предлагаемая структура проекта

```
http-rust/
├── Cargo.toml               # crate cdylib, napi-rs
├── package.json             # napi-конфиг, targets, optionalDependencies
├── build.rs
├── src/                     # Rust
│   ├── lib.rs               # napi-экспорты, RustServer
│   ├── server.rs            # tokio + hyper + rustls, listen/accept
│   ├── router.rs            # matchit, предкомпиляция цепочек
│   ├── bridge.rs            # ThreadsafeFunction, Promise↔Future, стрим-backpressure
│   ├── middleware/          # нативные: body_limit, cors, timeout
│   ├── stream.rs            # мост Web Streams ↔ hyper body
│   ├── tls.rs               # rustls config, ALPN
│   ├── health.rs            # /healthz, /readyz
│   ├── metrics.rs           # Prometheus
│   └── shutdown.rs          # сигналы, drain, GOAWAY
├── js/                      # JS-обёртка
│   ├── index.js / index.d.ts
│   ├── context.js           # c, c.req, c.res
│   ├── onion.js             # композиция луковицы
│   └── streams.js           # Web Streams адаптеры
├── __test__/                # интеграционные тесты (JS)
├── examples/
└── DESIGN.md
```

## 15. Фазировка

**v1 (MVP):**
- Мост Rust↔JS (ThreadsafeFunction, Promise↔Future).
- tokio + hyper + rustls; HTTP/1.1, HTTP/2 (ALPN), h2c prior-knowledge.
- Роутинг на matchit; методы; `baseUrl`; 404/405 в Rust; `app.notFound`/`app.onError`.
- Луковица middleware с предкомпиляцией; глоб./префикс./маршрут./группы.
- **Хуки жизненного цикла** (Fastify-стиль): `onRequest`…`onResponse`, `onError/onTimeout/onAbort`; `AbortSignal`.
- Контекст в JS; `c.json/text/body/status/header`; возврат-значение как сахар; `c.req.ip/ips/country/id`; `c.log`.
- Стриминг запрос/ответ через Web Streams + backpressure; multipart (per-route, `parts()`).
- **Схемы (A6):** valibot → JSON Schema → нативная валидация/сериализация в Rust; слоёно; `preValidation`.
- Нативные middleware: body-limit, cors, timeout.
- **Безопасность/сеть (A1–A4):** Rapid-Reset лимит, read-таймауты, `workerThreads:auto` (cgroup), PROXY protocol; socket-опции; HEAD/OPTIONS/405/431; `maxConcurrentRequests` (503/GOAWAY + readiness-shedding + очередь).
- **DX (B):** cookies, request-id (UUIDv7), urlencoded, входящая декомпрессия, `redirect/notFound/streamSSE`, server-события, `app.inject()`.
- Graceful shutdown; `/healthz`, `/readyz` + readiness-колбэк; `/metrics`; JSON-лог; multi-port.
- Сборка napi-rs: linux gnu x64/arm64 (baseline) + musl + darwin-arm64; prebuild в npm.

**Фаза 2 (по мере надобности):**
- Нативный **compression** (gzip/brotli, стриминг).
- **worker_threads**-пул (только если профайлинг покажет CPU-bound JS — не ожидается).
- Hot-reload TLS-сертификатов; trust-proxy CIDR; серверный GeoIP по IP.
- zod/arktype (Standard Schema) через `toJsonSchema`; подписанные/шифрованные cookies; `saveTo()` для multipart; `allowedExtensions`→расширенный.
- W3C Trace Context / OpenTelemetry.
- Доп. platform-таргеты (darwin-x64, windows).
- **НЕ планируется:** WebSocket, статик-файлы, Range/трейлеры, HTML-рендеринг.

## 17. Тестирование и бенчмарки

- **Rust unit** (`cargo test`): роутер, предкомпиляция цепочек, парсеры (query, единицы, заголовки), нативные middleware.
- **JS-интеграционные** (сервер на случайном порту, `undici`/`fetch`): маршруты, params/query, порядок луковицы, `onError`, 404/405, стриминг (запрос/ответ, SSE), TLS+ALPN (h1/h2), h2c, graceful shutdown, health/metrics. На всех LTS-Node.
- **Мост/утечки**: прогон N запросов, контроль RSS/heap; паника в Rust не роняет процесс; `unhandledRejection` не срабатывает.
- **Бенчмарки**: `h2load` (h2), `bombardier`/`oha` (h1) — RPS, p50/p99; сравнение с `node:http`, Fastify, Hono-на-Node; отдельно стриминг/SSE.
- **CI** (GitHub Actions): матрица сборки (linux gnu/musl x64/arm64, darwin) + `cargo test` + JS-тесты на Node 18/20/22/24; публикация prebuild по тегу.

## 16. Открытые вопросы (все закрыты)

- ~~Имя npm-пакета / scope~~ → `@oxide/http`, класс `Server`.
- ~~Query-string парсинг~~ → в **Rust** заранее; `c.req.query` = last-wins строки; `c.req.queries('k')` → массив всех значений.
- ~~Представление заголовков~~ → lowercase везде; `c.req.header(name)` + `c.res.headers` (`set`/`append`); `Set-Cookie` отдельными строками; псевдо-заголовки h2 скрыты.
- ~~Формат единиц в конфиге~~ → принимаем **и строку, и число** (`'10mb'`/`'30s'` или байты/мс), тип `string | number`.
- ~~Стратегия тестирования/бенчмарков~~ → см. §17.
- ~~baseUrl, customIpHeaders, customCountryHeaders, multipart~~ → добавлены (§4, §9a).
- ~~Аудит полноты (A1–A6, B1–B10, WebSocket, схемы)~~ → решено: A1–A4+A6+вся B в v1; WebSocket не поддерживаем; схемы valibot→JSON Schema→Rust.
