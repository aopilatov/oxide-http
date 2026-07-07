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

## M1 — Шагающий скелет: мост Rust↔JS  ⬜
**Цель:** доказать самое рискованное — сквозной путь сокет→Rust→JS→ответ.
**Раздел дизайна:** §3, §2 (мост).

- [ ] Класс `Server` через `#[napi]`; конструктор принимает конфиг-объект (пока минимум).
- [ ] Внутри аддона поднять **свой `tokio`-рантайм** (отдельно от libuv).
- [ ] `listen(port)` → hyper слушает plaintext HTTP/1.1.
- [ ] Один захардкоженный `GET /` → вызвать JS через **`ThreadsafeFunction`**.
- [ ] Приём результата: интеграция **JS `Promise` ↔ Rust `Future`** (`await` без блокировки tokio-потока).
- [ ] JS-хендлер возвращает `{ status, headers, body }`; Rust пишет ответ.
- [ ] Аккуратное завершение рантайма при `close()`.

**DoD:** `curl localhost:3000/` → JSON от JS-хендлера; нет паник; `close()` не течёт.

---

## M2 — Роутинг (matchit)  ⬜
**Цель:** регистрация маршрутов и матчинг в Rust.
**Разделы:** §5, §6 (частично), §6c (B10).

- [ ] Регистрация из JS: `get/post/put/patch/delete/head/options/all(path, handler)`.
- [ ] `matchit`-дерево на метод; извлечение `params`.
- [ ] `baseUrl`-префикс (склейка при регистрации) + нормализация значения.
- [ ] `404` (нет пути) и `405` + заголовок `Allow` (есть путь, нет метода) — в Rust.
- [ ] Авто-`HEAD` (как GET без тела), авто-`OPTIONS`.
- [ ] Query-парсинг в Rust: `c.req.query` (last-wins), `c.req.queries(k)` (массив).
- [ ] `app.notFound` (опц. пробуждение JS).
- [ ] Группы `app.route(prefix, sub)` — склейка префиксов.

**DoD:** cargo-тесты роутера (static/`:param`/catch-all/приоритет, 404/405, baseUrl, группы); JS-тест: `/users/:id` отдаёт `params`.

---

## M3 — Контекст и контракт ответа  ⬜
**Цель:** объект `c` и хелперы ответа.
**Разделы:** §6b/§7 (контекст), §8, заголовки (§16), B1–B3.

- [ ] `c.req`: `method`, `path` (без baseUrl), `url/rawPath`, `params`, `query`, `headers`.
- [ ] Модель заголовков: lowercase, `c.req.header(name)`, `c.res.headers` (`set`/`append`), `Set-Cookie` отдельными строками, псевдо-h2 скрыты.
- [ ] `c.req.ip`/`c.req.ips` (по `customIpHeaders` + fallback peer), `c.req.country` (по `customCountryHeaders`).
- [ ] `c.req.id` (UUIDv7, если нет `x-request-id`), проброс в ответ; `c.log` (JSON с requestId).
- [ ] `c.set/get`; `c.status/header`; `c.json/text/body`; возврат-значение как сахар.
- [ ] Cookies: `c.req.cookie(name)`, `c.cookie(name, val, opts)`.
- [ ] Парсер единиц конфига (`'10mb'`/`'30s'` | число).

**DoD:** JS-тесты: заголовки регистронезависимы; `Set-Cookie` двумя строками; `ip`/`country` из заголовков; requestId генерируется; `c.json` ставит статус/тип.

---

## M4 — Тело запроса/ответа + стриминг  ⬜
**Цель:** второй главный риск — стрим-backpressure через мост.
**Разделы:** §9 (стриминг), B4, B5.

- [ ] Буферизация тела с `bodyLimit`: `await c.req.json()/text()/arrayBuffer()`.
- [ ] **Запрос-стрим:** `c.req.stream` (Web `ReadableStream`); backpressure JS→Rust.
- [ ] **Ответ-стрим:** `c.body(ReadableStream | AsyncIterable)`; backpressure Rust→JS.
- [ ] urlencoded (`c.req.formData()`/`parseBody()`); входящая декомпрессия (`Content-Encoding`) в Rust с учётом лимита по распакованному.
- [ ] Адаптеры к Node-стримам (`Readable.fromWeb/toWeb`).

**DoD:** тесты: большой upload не грузит память (стрим); SSE-ответ идёт чанками; backpressure реально тормозит producer'а; `413` при превышении лимита.

---

## M5 — Луковица middleware + хуки жизненного цикла  ⬜
**Цель:** композиция и полный lifecycle.
**Разделы:** §6, §6a.

- [ ] JS-композиция луковицы (`(c, next) => {}`); подряд-JS одним куском.
- [ ] Предкомпиляция цепочек на `listen()` для каждого листа маршрута.
- [ ] Scope: глобальные + префиксные + маршрутные + группы (инкапсуляция).
- [ ] Хуки: `onRequest`, `preParsing`, `preValidation`(заглушка до M7), `preHandler`, `preSerialization`, `onSend`, `onResponse`, `onConnect/onClose`.
- [ ] Именованные методы + `addHook`; маршрутные — через опции.
- [ ] Единый `onError` (наблюдение+формирование); `try/catch` инвариант «процесс не падает»; `catch_unwind` на границах; страховочный `unhandledRejection`.
- [ ] `onTimeout`/`onAbort` + `c.req.signal` (AbortSignal), одноразовое срабатывание.
- [ ] Short-circuit; «после»-хуки всегда; флаги `c.res.sent`/`c.aborted`.

**DoD:** тесты: порядок хуков и луковицы; short-circuit из `onRequest`; ошибка в любом слое → `onError`; таймаут→504 + abort; паника в Rust не роняет процесс.

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
