# `@oxide/http` — план реализации (v1)

Пошаговый план. Основан на [DESIGN.md](DESIGN.md). Порядок milestone'ов подобран так, чтобы
**сначала снять главные риски** (мост napi-rs, стрим-backpressure), а фичи наращивать слоями.
Каждый milestone имеет: цель, задачи, критерии готовности (DoD), ссылку на раздел дизайна.

Легенда: ⬜ не начато · 🟡 в работе · ✅ готово.

---

## Критический путь (что от чего зависит)

```
M0 тулчейн ─▶ M1 мост(скелет) ─▶ M2 роутинг ─▶ M3 контекст ─▶ M4 тело/стриминг
                                                                      │
                    ┌────────────────────────┬───────────────────────┤
                    ▼                        ▼                        ▼
             M5 middleware+хуки       M6 нативные mw           M7 схемы
                    │                        │                        │
                    └────────────┬───────────┴────────────┬───────────┘
                                 ▼                         ▼
                          M8 multipart            M9 TLS/h2/h2c
                                 │                         │
                                 └────────────┬────────────┘
                                              ▼
                        M10 shutdown/overload ─▶ M11 health/metrics
                                              ▼
                        M12 тесты/бенчи ─▶ M13 сборка/доставка ─▶ M14 релиз
```

---

## M0 — Окружение и тулчейн  ✅
**Цель:** воспроизводимая сборка `.node` на dev-машине.
**Раздел дизайна:** §13.

- [x] Установить `rustup` + Rust stable; добавить компонент `rustfmt`, `clippy`. (Rust 1.96.0)
- [x] Установить целевые триплеты для локали: `aarch64-apple-darwin` (dev).
- [x] `package.json`: `@oxide/http`, `engines.node >= 18`, devDeps `@napi-rs/cli` (v3.7.2).
- [x] `Cargo.toml`: `crate-type = ["cdylib"]`, `napi`/`napi-derive` (napi8), `tokio`, `hyper`.
- [x] `napi` конфиг: список `targets`, `binaryName`, генерация `.d.ts`.
- [x] `build.rs` (napi build).
- [x] Скрипты: `build` (debug), `build:release`, `artifacts`, `test` (+ `format`, `lint`).
- [x] `.gitignore`, `rust-toolchain.toml` (закрепить версию), `rustfmt.toml`, `clippy` в CI-заготовке.

**DoD:** ✅ `npm run build` собирает `oxide-http.darwin-arm64.node`; тривиальный экспорт `sum(a,b)` вызывается из Node (`__test__/sum.test.mjs` зелёный); `cargo fmt --check` и `cargo clippy -D warnings` чисто.

---

## M1 — Шагающий скелет: мост Rust↔JS  ✅
**Цель:** доказать самое рискованное — сквозной путь сокет→Rust→JS→ответ.
**Раздел дизайна:** §3, §2 (мост).

- [x] Класс `Server` через `#[napi]`; конструктор (конфиг — минимум/пусто, расширяется на M3+).
- [x] Внутри аддона поднять **свой `tokio`-рантайм** (multi-thread, отдельно от libuv).
- [x] `listen(port, handler)` → hyper слушает plaintext HTTP/1.1 (bind синхронно → ранние ошибки).
- [x] Любой запрос → вызов JS через **`ThreadsafeFunction`** (`Arc<Handler>`, один переход/запрос).
- [x] Приём результата: **JS `Promise` ↔ Rust `Future`** (`call_async` → `promise.await`, без блокировки tokio-потока).
- [x] JS-хендлер возвращает `{ status?, headers?, body? }`; Rust пишет ответ (`Full<Bytes>`).
- [x] Завершение рантайма при `close()` (`notify` + `shutdown_background`, идемпотентно).

**DoD:** ✅ `fetch localhost:38080/hello` → JSON от JS-хендлера (`__test__/server.test.mjs`); `throw` в хендлере → `500`, процесс жив; `close()` идемпотентен, освобождает порт, снимает ref TSFN (тест-процесс завершается сам — нет утечки); clippy/fmt чисто.

Файлы: [src/lib.rs](src/lib.rs) (класс `Server`, рантайм), [src/server.rs](src/server.rs) (accept-цикл, hyper), [src/bridge.rs](src/bridge.rs) (типы, TSFN-`Handler`).

---

## M2 — Роутинг (matchit)  ✅
**Цель:** регистрация маршрутов и матчинг в Rust.
**Разделы:** §5, §6 (частично), §6c (B10).

- [x] Регистрация из JS: `get/post/put/patch/delete/head/options/all(path, handler)`.
- [x] `matchit`-дерево на метод (+ отдельное на `ALL`); извлечение `params`.
- [x] `baseUrl`-префикс (склейка при регистрации) + нормализация значения.
- [x] `404` (нет пути) и `405` + заголовок `Allow` (есть путь, нет метода) — в Rust.
- [x] Авто-`HEAD` (как GET без тела, `content-length` сохраняется), авто-`OPTIONS` (`204`+`Allow`).
- [x] Query-парсинг в Rust (`form_urlencoded`): `c.req.query` (last-wins), `c.req.queries(k)` (массив).
- [x] `app.notFound` (опц. пробуждение JS через `leaf_id = -1`).
- [x] Группы `app.route(prefix, sub)` — склейка префиксов.
- [x] **Введена JS-обёртка** `js/index.js` (класс `Server`) поверх нативного `RustServer` (§14).

**DoD:** ✅ 9 cargo-тестов роутера (static/`:param`/catch-all/приоритет, 404/405+Allow, baseUrl, группы, ALL, конфликт); 9 JS-тестов (params, query, 404/405, авто-HEAD/OPTIONS, baseUrl, группы, notFound); clippy/fmt чисто.

⚠️ **Отклонение от дизайна:** matchit 0.8 не поддерживает несколько параметров в одном сегменте
(`/{id}.{ext}`) — «один параметр на сегмент». DESIGN.md §5/§7 обновлён; обход — матчить сегмент
целиком и делить в хендлере.

Файлы: [src/router.rs](src/router.rs) (matchit, трансляция синтаксиса, Allow), [src/server.rs](src/server.rs) (матчинг в accept-цикле), [src/lib.rs](src/lib.rs) (`RustServer.listen` с таблицей), [js/index.js](js/index.js) (класс `Server`, реестр хендлеров, контекст).

---

## M3 — Контекст и контракт ответа  ✅
**Цель:** объект `c` и хелперы ответа.
**Разделы:** §6b/§7 (контекст), §8, заголовки (§16), B1–B3.

- [x] `c.req`: `method`, `path` (без baseUrl), `url`/`rawPath`, `params`, `query`, `headers`.
- [x] Модель заголовков: lowercase, `c.req.header(name)`, `c.res.headers` (`set`/`append`), `Set-Cookie` отдельными строками (Vec<KvPair> на границе).
- [x] `c.req.ip`/`c.req.ips` (по `customIpHeaders` + fallback peer, вычислено в Rust), `c.req.country` (по `customCountryHeaders`).
- [x] `c.req.id` (UUIDv7 в Rust, если нет `x-request-id`), проброс в ответ; `c.log` (JSON с requestId).
- [x] `c.set/get`; `c.status/header`; `c.json/text/body`; возврат-значение как сахар (object→json, string→text).
- [x] Cookies: `c.req.cookie(name)`, `c.cookie(name, val, opts)`.
- [x] Парсер единиц конфига (`'10mb'`/`'30s'` | число) — [js/units.js](js/units.js).

**DoD:** ✅ 11 M3-тестов (заголовки регистронезависимы; `Set-Cookie` двумя строками; `ip`/`ips`/`country` из заголовков + peer-fallback; requestId генерируется/сохраняется; `c.json` ставит статус/тип; сахар; `c.set/get`; path без baseUrl; парсер единиц). Всего 17 JS + 9 cargo. clippy/fmt чисто.

Файлы: [js/context.js](js/context.js) (контекст `c`, ResHeaders, cookies, логгер, финализация), [js/units.js](js/units.js) (парсер единиц), [src/server.rs](src/server.rs) (заголовки/ip/country/id в Rust), [src/bridge.rs](src/bridge.rs) (расширенный `MatchedRequest`, `headers: Vec<KvPair>` в ответе).

---

## M4 — Тело запроса/ответа + стриминг  ✅
**Цель:** второй главный риск — стрим-backpressure через мост.
**Разделы:** §9 (стриминг), B4, B5.

- [x] Буферизация тела с `bodyLimit`: `await c.req.json()/text()/arrayBuffer()`.
- [x] **Запрос-стрим:** `c.req.stream` (Web `ReadableStream`); backpressure JS→Rust (bounded-канал cap 1, сокет читается по `bodyIo.read()`).
- [x] **Ответ-стрим:** `c.body(ReadableStream | AsyncIterable | Buffer)`; backpressure Rust→JS (канальный hyper `Body`, `bodyIo.write()` ждёт разгрузки).
- [x] urlencoded (`c.req.formData()`/`parseBody()`); входящая декомпрессия (`Content-Encoding` gzip/deflate/br) с учётом лимита по распакованному.
- [x] Адаптеры: `c.req.stream` — Web `ReadableStream` (Node-адаптеры `Readable.fromWeb/toWeb` доступны из коробки).

**DoD:** ✅ 8 M4-тестов: json/text/parseBody; большой upload (12.8MB) стримом; `413` по лимиту; gzip-декомпрессия; SSE-ответ чанками; `c.body(Buffer)` бинарно; **backpressure ответа реально тормозит producer** (`producedEarly < 100`). Всего 25 JS + 9 cargo. clippy/fmt чисто.

**Безопасность body-limit (усилено по запросу):** лимит тела — **авторитетный в Rust**
(`read_body_task` считает фактические байты, не доверяя `Content-Length`; при превышении
шлёт `Overflow` и прекращает читать сокет). Нельзя обойти из хендлера (в т.ч. через сырой
`c.req.stream`) и работает для `chunked` без `Content-Length`. Плюс ранний `413` по
заявленному `Content-Length` (до чтения тела). Request smuggling / фрейминг — на hyper
(отклоняет конфликт `CL`+`TE`, не даёт читать за границу тела). 5 security-тестов
([body-limit.test.mjs](__test__/body-limit.test.mjs)). Buffer overflow невозможен (Rust/JS memory-safe).

⚠️ **Отклонения от дизайна (флаг):**
- **Декомпрессия — в JS** (`node:zlib`, streaming-safe с `maxOutputLength`), а не в Rust. Функционально эквивалентно (лимит по распакованному соблюдается); перенос в Rust-стрим — фаза 2.
- **Нативный body-limit как отдельный middleware** (§10-набор) остаётся на M6, но авторитетное enforcement уже сделано здесь (см. выше).
- Неконсумленное тело запроса при keep-alive: соединение может не переиспользоваться (корректность сохранена). Приемлемо для v1.

Файлы: [src/stream.rs](src/stream.rs) (класс `BodyIo`, канальный `ChannelBody`), [src/server.rs](src/server.rs) (чтение тела в канал, `BoxBody`), [js/context.js](js/context.js) (тело запроса, стрим ответа, декомпрессия, `HttpError`).

---

## M5 — Луковица middleware + хуки жизненного цикла  ✅
**Цель:** композиция и полный lifecycle.
**Разделы:** §6, §6a.

- [x] JS-композиция луковицы (`(c, next) => {}`); весь пайплайн — один переход границы/запрос (все слоты JS).
- [x] Предкомпиляция цепочек на `listen()` для каждого листа маршрута ([js/pipeline.js](js/pipeline.js) `buildChain`).
- [x] Scope: глобальные + префиксные (`use('/p/*', fn)`) + маршрутные + группы (инкапсуляция через префикс-матчинг).
- [x] Хуки: `onRequest`, `preParsing`, `preValidation`(пустая стадия до M7), `preHandler`, `preSerialization`, `onSend`, `onResponse`.
- [x] Именованные методы (`app.onRequest(fn)`…) + `addHook(name, fn)`; маршрутные — через опции `get(path, {onRequest:[...]}, ...mw, handler)`.
- [x] Единый `onError` (наблюдение+формирование, несколько последовательно); `try/catch` инвариант «процесс не падает»; страховочный `unhandledRejection`-хендлер.
- [x] `onTimeout` + `c.req.signal` (AbortSignal), одноразовое срабатывание; таймаут → 504, латч ответа против гонки.
- [x] Short-circuit; «после»-хуки (`preSerialization`/`onSend`/`onResponse`) идут всегда; флаги `c.res.sent`/`c.aborted`.

**DoD:** ✅ 10 M5-тестов: порядок луковицы; порядок хуков; short-circuit из `onRequest`; `onError` ловит throw из хендлера/mw; throw без onError → 500 (процесс жив); таймаут→504+onTimeout+abort; route-mw+route-хуки; инкапсуляция групп; префиксный `use`; `onSend` дорабатывает заголовки. Всего 40 JS + 9 cargo. clippy/fmt чисто.

⚠️ **Стабы/отложено (флаг):**
- `onConnect`/`onClose` — регистрируются, но **не срабатывают** (connection-level события — в Rust, придут с native-слоем M6/M9).
- `onAbort` — регистрируется, но реальный дисконнект клиента ещё не сигналится из Rust (нужен native-хук; таймаут идёт в `onTimeout`). — M6/M9.
- `catch_unwind` на границах Rust — явно не добавлен; выживание процесса уже обеспечено изоляцией tokio-задач (паника задачи не роняет рантайм). Явный `catch_unwind` + тест паники — M12.
- Native middleware (cors/body-limit/timeout как Rust-слоты) и «подряд-JS одним куском» при смешанных слотах — M6.

Файлы: [js/pipeline.js](js/pipeline.js) (движок, предкомпиляция, onError, таймаут), [js/index.js](js/index.js) (регистрация use/хуков/групп, диспетчер), [js/context.js](js/context.js) (`applyReturnValue`/`buildNativeResponse`, signal/sent/aborted, `_settled`-латч).

---

## M6 — Нативные middleware  ⬜
**Цель:** body-limit / cors / timeout в Rust.
**Разделы:** §10-набор (v1), §6a (вход/выход).

- [ ] **body-limit** — `413` до/во время чтения тела.
- [ ] **cors** — preflight `OPTIONS` в Rust до `onRequest`; origin-check на входе; `Access-Control-*` на `onSend`.
- [ ] **timeout** — старт дедлайна → ветка `onTimeout`.
- [ ] Размещение как нативные слоты в предкомпилированной цепочке (края луковицы).

**DoD:** тесты: preflight не будит JS; запрещённый origin отклонён; `413` по лимиту; таймаут срабатывает.

---

## M7 — Схемы: valibot → JSON Schema → нативный Rust  ⬜
**Цель:** валидация/сериализация по схеме вне event loop.
**Раздел:** §6b.

- [ ] Приём `schema: { body, query, params, response }` (valibot | сырой JSON Schema).
- [ ] Конвертация valibot → JSON Schema (`@valibot/to-json-schema`) на регистрации.
- [ ] Rust компилирует валидатор (`jsonschema`) при `listen()`.
- [ ] Стадия `preValidation`: Rust структурно → `400`; затем JS-valibot доигрывает `transform`/`check`.
- [ ] Коэрция query/params по схеме (`?age=42`→number).
- [ ] `c.req.valid('body'|'query'|'params')` (типизировано).
- [ ] Ответ: нативная сериализация по схеме + отсечение лишних полей; валидация ответа — dev-only.
- [ ] Формат ошибок `400`: `[{ path, message, code }]`, переопределяемо.

**DoD:** тесты: невалидное тело → `400` без пробуждения JS; `transform` применяется; лишние поля отсекаются в ответе; коэрция query работает.

---

## M8 — Multipart  ⬜
**Цель:** потоковая загрузка файлов per-route.
**Раздел:** §9a.

- [ ] Опция маршрута `{ multipart: true | {...limits} }`; не тот Content-Type → `415`.
- [ ] Rust-парсер (`multer`, потоково); `c.req.parts()` (async-итератор, файл=Web `ReadableStream`).
- [ ] Сахар `c.req.formData()` (в память, под `maxFileSize`).
- [ ] Лимиты: `maxFileSize`→413, `maxFiles`/`maxFields`→400, `maxFieldSize`.
- [ ] Типы: `allowedMimeTypes` (wildcard) **и** `allowedExtensions` → `415`; только для частей с `filename`.

**DoD:** тесты: большой файл стримится без OOM; превышение лимита→413; неверный тип→415; текстовые поля читаются.

---

## M9 — TLS / HTTP/2 / h2c + read-таймауты  ⬜
**Цель:** шифрование и мультиплекс.
**Разделы:** §12, §6c (A1, A2).

- [ ] `rustls`-конфиг; серты из пути и Buffer/PEM; ALPN → `h2`/`http/1.1`.
- [ ] HTTP/2 (hyper h2): `maxConcurrentStreams`, `initialWindowSize`.
- [ ] **A1** Rapid-Reset лимит (`maxResetStreamsPerSec`).
- [ ] **h2c prior-knowledge** на plaintext-порту (по флагам).
- [ ] **A2** таймауты: `headerReadTimeout`, `bodyReadTimeout`, `idleTimeout`, `keepAliveTimeout`.
- [ ] `maxHeaderSize` → `431`.

**DoD:** тесты: ALPN согласует h2 с браузером/`h2load`; h1.1 fallback; h2c prior-knowledge; Slowloris отсекается таймаутом; серт из Buffer грузится.

---

## M10 — Жизненный цикл сервера / shutdown / overload  ⬜
**Цель:** корректная работа под k8s.
**Разделы:** §10, §6c (A3, A4, B7, B9, C5).

- [ ] `listen({ port, host })` и **Unix-сокет** (`{ path }`); multi-port (health/metrics отдельно).
- [ ] Server-события: `listening`, `error` (EADDRINUSE → reject), `close`.
- [ ] **Graceful shutdown:** SIGTERM/SIGINT → закрыть listener → readiness not-ready → drain in-flight (вкл. JS) → h2 `GOAWAY` → дедлайн `shutdownTimeout` → форс → событие `shutdown` + `await close()` → exit 0.
- [ ] **C5 `maxConcurrentRequests`:** счётчик in-flight; `503`+`Retry-After`(+`GOAWAY` h2) сверх лимита; очередь `maxQueue`/`queueTimeout`; readiness-shedding при устойчивой перегрузке.
- [ ] **A3** `workerThreads:'auto'` — чтение cgroup CPU-квоты (v1/v2).
- [ ] **A4** PROXY protocol v1/v2 (socket-level) → peer-IP, взаимодействие с `customIpHeaders`.
- [ ] **B9** socket-опции: `TCP_NODELAY`, `SO_REUSEPORT`, `backlog`, `maxConnections`.

**DoD:** тесты: SIGTERM дожидается in-flight и отдаёт 0; перегрузка→503+Retry-After; readiness падает под нагрузкой; cgroup-квота уменьшает число потоков; PROXY-protocol даёт реальный IP.

---

## M11 — Health / observability  ⬜
**Цель:** пробы и метрики.
**Раздел:** §11.

- [ ] `/healthz` (Rust, мгновенно).
- [ ] `/readyz` (Rust): shutdown-aware + `app.setReadinessCheck()` (спрашивает JS) + overload-aware.
- [ ] `/metrics` Prometheus (Rust): RPS, латентности-гистограммы, коды, соединения/стримы, in-flight, размеры; на отдельном порту.
- [ ] Структурный JSON-лог в stdout; access-log; `c.log`.

**DoD:** тесты: `/readyz` реагирует на shutdown/overload/колбэк; `/metrics` в формате Prometheus; health на отдельном порту.

---

## M12 — Тестирование и бенчмарки  ⬜
**Цель:** качество и цифры.
**Раздел:** §17.

- [ ] `app.inject(req)` — тест-харнесс без сокета.
- [ ] Интеграционный набор на Node 18/20/22/24.
- [ ] Тесты утечек/паник (RSS/heap под нагрузкой; `unhandledRejection` не срабатывает).
- [ ] Бенчи: `h2load` (h2), `bombardier`/`oha` (h1); сравнение с `node:http`, Fastify, Hono-на-Node; отдельно стриминг/SSE.
- [ ] Отчёт p50/p99/RPS в `BENCHMARKS.md`.

**DoD:** зелёный CI на всех Node LTS; бенч-отчёт с числами; нет утечек за N=1e6 запросов.

---

## M13 — Сборка и доставка (prebuild)  ⬜
**Цель:** «работает в любом образе».
**Раздел:** §13.

- [ ] Кросс-сборка в docker-образах napi-rs (baseline **glibc 2.17**): `x86_64/aarch64-unknown-linux-gnu`.
- [ ] `x86_64/aarch64-unknown-linux-musl`; `aarch64-apple-darwin` (+ опц. darwin-x64, windows).
- [ ] Platform-пакеты `@oxide/http-linux-x64-gnu` и т.д.; `optionalDependencies` + загрузчик через `detect-libc`.
- [ ] Генерация `.d.ts` (типы для `Server`, `c`, конфиг, схемы).
- [ ] CI (GitHub Actions): матрица сборки + `cargo test`/`clippy` + JS-тесты; публикация prebuild по git-тегу.
- [ ] Примеры Dockerfile: `ubuntu`, `ubi9`, `ubi10`, `alpine` — проверить, что `.node` подхватывается.

**DoD:** установка `npm i @oxide/http` в чистых образах Ubuntu/UBI9/UBI10/Alpine (x64 и arm64) — сервер стартует без Rust-тулчейна.

---

## M14 — Документация, примеры, релиз v1.0.0  ⬜
**Цель:** готово к использованию.

- [ ] `README.md` (быстрый старт, API, конфиг-справочник).
- [ ] `examples/`: базовый API, схемы (valibot), стриминг/SSE, multipart, middleware/хуки, TLS/h2.
- [ ] Пример k8s-манифеста: probes (`/healthz`/`/readyz`), `resources` (~1 vCPU), `terminationGracePeriodSeconds` > `shutdownTimeout`, HPA.
- [ ] `CHANGELOG.md`; SemVer; тег `v1.0.0` → публикация в npm.

**DoD:** `npm i @oxide/http`, пример из README поднимает сервер и проходит smoke-тест.

---

## Быстрые ориентиры по крейтам (Rust)

| Задача | Крейт |
|---|---|
| napi-мост | `napi`, `napi-derive` |
| async-рантайм | `tokio` |
| HTTP h1/h2 | `hyper`, `h2` |
| TLS | `rustls`, `tokio-rustls`, `rustls-pemfile` |
| роутинг | `matchit` |
| JSON Schema валидация | `jsonschema` |
| multipart | `multer` |
| PROXY protocol | `ppp` (или ручной парсер v1/v2) |
| декомпрессия | `flate2`, `brotli` |
| метрики | `prometheus` / ручной энкодер |
| UUIDv7 | `uuid` (v7) |
| cgroup-квота | чтение `/sys/fs/cgroup` (v1/v2) вручную |

## Заметки по рискам

- **Стрим-backpressure через границу (M4)** — самый тонкий механизм; заложить рано (после M1), не откладывать.
- **JS `Promise` ↔ Rust `Future` под нагрузкой** — проверить отсутствие утечек `ThreadsafeFunction`-ссылок (M1/M12).
- **cgroup-квота (M10, A3)** — различия cgroup v1/v2 и отсутствие лимита; безопасный fallback на число ядер.
- **valibot→JSON Schema (M7)** — не всё мапится; чётко очертить, что уходит в JS-слой, покрыть тестами.
