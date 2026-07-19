# `@oxide-ts/http` — план реализации (v1)

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
- [x] `package.json`: `@oxide-ts/http`, `engines.node >= 18`, devDeps `@napi-rs/cli` (v3.7.2).
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
- [x] **Введена JS-обёртка** `js/index.ts` (класс `Server`) поверх нативного `RustServer` (§14).

**DoD:** ✅ 9 cargo-тестов роутера (static/`:param`/catch-all/приоритет, 404/405+Allow, baseUrl, группы, ALL, конфликт); 9 JS-тестов (params, query, 404/405, авто-HEAD/OPTIONS, baseUrl, группы, notFound); clippy/fmt чисто.

⚠️ **Отклонение от дизайна:** matchit 0.8 не поддерживает несколько параметров в одном сегменте
(`/{id}.{ext}`) — «один параметр на сегмент». DESIGN.md §5/§7 обновлён; обход — матчить сегмент
целиком и делить в хендлере.

Файлы: [src/router.rs](src/router.rs) (matchit, трансляция синтаксиса, Allow), [src/server.rs](src/server.rs) (матчинг в accept-цикле), [src/lib.rs](src/lib.rs) (`RustServer.listen` с таблицей), [js/index.ts](js/index.ts) (класс `Server`, реестр хендлеров, контекст).

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
- [x] Парсер единиц конфига (`'10mb'`/`'30s'` | число) — [js/units.ts](js/units.ts).

**DoD:** ✅ 11 M3-тестов (заголовки регистронезависимы; `Set-Cookie` двумя строками; `ip`/`ips`/`country` из заголовков + peer-fallback; requestId генерируется/сохраняется; `c.json` ставит статус/тип; сахар; `c.set/get`; path без baseUrl; парсер единиц). Всего 17 JS + 9 cargo. clippy/fmt чисто.

Файлы: [js/context.ts](js/context.ts) (контекст `c`, ResHeaders, cookies, логгер, финализация), [js/units.ts](js/units.ts) (парсер единиц), [src/server.rs](src/server.rs) (заголовки/ip/country/id в Rust), [src/bridge.rs](src/bridge.rs) (расширенный `MatchedRequest`, `headers: Vec<KvPair>` в ответе).

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
([body-limit.test.mjs](__test__/body-limit.test.ts)). Buffer overflow невозможен (Rust/JS memory-safe).

⚠️ **Отклонения от дизайна (флаг):**
- **Декомпрессия — в JS** (`node:zlib`, streaming-safe с `maxOutputLength`), а не в Rust. Функционально эквивалентно (лимит по распакованному соблюдается); перенос в Rust-стрим — фаза 2.
- **Нативный body-limit как отдельный middleware** (§10-набор) остаётся на M6, но авторитетное enforcement уже сделано здесь (см. выше).
- Неконсумленное тело запроса при keep-alive: соединение может не переиспользоваться (корректность сохранена). Приемлемо для v1.

Файлы: [src/stream.rs](src/stream.rs) (класс `BodyIo`, канальный `ChannelBody`), [src/server.rs](src/server.rs) (чтение тела в канал, `BoxBody`), [js/context.ts](js/context.ts) (тело запроса, стрим ответа, декомпрессия, `HttpError`).

---

## M5 — Луковица middleware + хуки жизненного цикла  ✅
**Цель:** композиция и полный lifecycle.
**Разделы:** §6, §6a.

- [x] JS-композиция луковицы (`(c, next) => {}`); весь пайплайн — один переход границы/запрос (все слоты JS).
- [x] Предкомпиляция цепочек на `listen()` для каждого листа маршрута ([js/pipeline.ts](js/pipeline.ts) `buildChain`).
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

Файлы: [js/pipeline.ts](js/pipeline.ts) (движок, предкомпиляция, onError, таймаут), [js/index.ts](js/index.ts) (регистрация use/хуков/групп, диспетчер), [js/context.ts](js/context.ts) (`applyReturnValue`/`buildNativeResponse`, signal/sent/aborted, `_settled`-латч).

---

## M6 — Нативные middleware  ✅
**Цель:** body-limit / cors / timeout в Rust.
**Разделы:** §10-набор (v1), §6a (вход/выход).

- [x] **body-limit** — `413` до/во время чтения тела (авторитетно в Rust; сделано в M4, подтверждено).
- [x] **cors** — preflight `OPTIONS` в Rust **до пробуждения JS**; origin-check (`403` на запрещённый); `Access-Control-*` навешиваются на итоговый ответ ([src/cors.rs](src/cors.rs)).
- [x] **timeout** — дедлайн → ветка `onTimeout` (реализовано в M5; см. заметку ниже про раздел Rust/JS).
- [x] Края обрабатываются в Rust (`handle`: preflight/body-limit — до роутинга; CORS-заголовки — на выходе).

**DoD:** ✅ 8 M6-тестов: preflight не будит JS + отражает запрошенные заголовки; запрещённый origin → `403`; CORS-заголовки на ответе (+credentials/expose/vary); чужой origin — без ACAO, но обрабатывается; `credentials`+`*` отражает конкретный origin; maxAge; без cors — чисто; body-limit `413`. Плюс 4 cargo unit-теста cors. Всего 48 JS + 13 cargo. clippy/fmt чисто.

**Раздел timeout (по итогу обсуждения архитектуры):** request-level `requestTimeout` живёт в **JS** — его исход (`onTimeout`-хук, `AbortSignal`, формирование `c.res`) целиком JS, тащить это в Rust = лишнее пересечение границы. Нативными (в Rust, до пробуждения JS) остаются **read-таймауты** (`headerReadTimeout`/`bodyReadTimeout`/`idleTimeout` — Slowloris) — их место в **M9**. cors preflight и body-limit — настоящие «краевые» нативные middleware, оборвут запрос ни разу не зайдя в JS.

⚠️ **Ограничение (флаг):** нативный CORS `origin` поддерживает `*` и список строк; **origin-функция не нативна** (это JS) — для динамической логики пишется обычный JS-middleware. Задокументировано в [src/cors.rs](src/cors.rs).

Файлы: [src/cors.rs](src/cors.rs) (политика CORS), [src/server.rs](src/server.rs) (`handle` с краями + `apply_cors`), [src/lib.rs](src/lib.rs) (`CorsOptions`), [js/index.ts](js/index.ts) (`normalizeCors`).

---

## M7 — Схемы: valibot → JSON Schema → нативный Rust  ✅
**Цель:** валидация/сериализация по схеме вне event loop.
**Раздел:** §6b.

- [x] Приём `schema: { body, query, params, response }` (valibot | сырой JSON Schema) в route-опциях.
- [x] Конвертация valibot → JSON Schema (`@valibot/to-json-schema`, `errorMode:'ignore'`) на `listen()`.
- [x] Rust компилирует валидатор (`jsonschema`) при `listen()` (ошибка схемы → ранний reject).
- [x] Слоёная валидация: **Rust структурно → `400` без пробуждения JS**; затем JS-valibot доигрывает `transform`/`check` (синтетический `preValidation`).
- [x] Коэрция query/params по типам из схемы (`?age=42`→number, в Rust).
- [x] `c.req.valid('body'|'query'|'params')` — valibot-output поверх Rust-коэрции.
- [x] Ответ: **отсечение лишних полей** по response-схеме (в JS; не утечёт то, чего нет в схеме).
- [x] Формат ошибок `400`: `{ error:'validation', issues:[{ in, path, message, code }] }`.

**DoD:** ✅ 8 M7-тестов: невалидное тело → `400` без пробуждения JS (`handlerCalled===false`); валидное проходит; коэрция query; **valibot transform применяется**; refine/check → `400`; **лишние поля отсекаются в ответе**; сырой JSON Schema; params-валидация. Плюс 5 cargo unit-тестов schema. Всего 56 JS + 18 cargo. clippy/fmt чисто.

⚠️ **Отклонения/границы (флаг):**
- **Нативный сериализатор ответа** (аналог `fast-json-stringify`) — не сделан; отсечение полей выполняется в JS (корректно и безопасно). Быстрый Rust-сериализатор — фаза 2.
- **Сжатое тело + схема:** Rust не валидирует (декомпрессия — в JS, M4-деviation), тело валидирует valibot в JS. Несжатое тело → нативная Rust-валидация (fast-path).
- **Стрип ответа — верхний уровень** (вложенные объекты не рекурсивно); nested — фаза 2.
- **Массивы в query** (`?k=a&k=b` при `type:array`) — коэрция last-wins скаляров; массивы — фаза 2.
- **valibot/@valibot/to-json-schema** сейчас в `devDependencies`; для релиза → **optional peerDependencies** (M13).
- **Переопределение ошибок валидации в onError** (§6b) — сейчас Rust отдаёт стандартный `400` без JS; JS-override — фаза 2.

Файлы: [src/schema.rs](src/schema.rs) (компиляция/коэрция/валидация), [js/schema.ts](js/schema.ts) (конвертация/valibot/стрип), [src/server.rs](src/server.rs) (буферизация+валидация в dispatch), [js/context.ts](js/context.ts) (`c.req.valid`, стрип), [js/index.ts](js/index.ts) (route-схемы, синтетический `preValidation`).

---

## M8 — Multipart  ✅
**Цель:** потоковая загрузка файлов per-route.
**Раздел:** §9a.

- [x] Опция маршрута `{ multipart: true | {...limits} }`; не тот Content-Type → `415` (в Rust, без JS).
- [x] Rust-парсер (`multer`, потоково); `c.req.parts()` (async-итератор, часть = `{ name, filename?, contentType?, stream, text, arrayBuffer }`).
- [x] Сахар `c.req.formData()` (Web `FormData`; файлы → `Blob`, поля → строки).
- [x] Лимиты: `maxFileSize`→413, `maxFiles`/`maxFields`→400, `maxFieldSize`→400 (в Rust, до передачи в JS).
- [x] Типы: `allowedMimeTypes` (wildcard `image/*`) **и** `allowedExtensions` → `415`; только для частей с `filename`, до вычитывания файла.
- [x] Двухуровневый стриминг через мост: события `Part`/`Chunk`/`PartEnd`/`Reject` в bounded-канале (backpressure).

**DoD:** ✅ 7 M8-тестов: потоковая загрузка (файлы+поля); большой файл (8MB) стримом; `maxFileSize`→413; неверный MIME→415; неверное расширение→415; не-multipart Content-Type→415; `formData()` сахар. Плюс 2 cargo unit-теста (mime/ext). Всего 63 JS + 20 cargo. clippy/fmt чисто.

Механика: диск не трогаем (только потоки). `multer` парсит вне event loop, лимиты/типы проверяются в Rust **до** передачи файла в JS. Отклонение (`413`/`415`/`400`) кодируется в napi-ошибке `MULTIPART_REJECT:<status>:...`, JS маппит в `HttpError` → нужный статус.

⚠️ **Границы (флаг):** `saveTo(path)` (автозапись на диск) — фаза 2; `allowedExtensions` — простое сравнение по суффиксу.

Файлы: [src/multipart.rs](src/multipart.rs) (парсер, лимиты, типы), [src/stream.rs](src/stream.rs) (`BodyIo.nextPart/readPart`, `PartMeta`), [src/server.rs](src/server.rs) (415/boundary/spawn в dispatch), [js/context.ts](js/context.ts) (`c.req.parts/formData`), [js/index.ts](js/index.ts) (`normalizeMultipart`).

---

## M9 — TLS / HTTP/2 / h2c + read-таймауты  ✅
**Цель:** шифрование и мультиплекс.
**Разделы:** §12, §6c (A1, A2), §6c (B10).

- [x] `rustls`-конфиг (провайдер `ring`); серты из пути и Buffer/PEM; ALPN → `h2`/`http/1.1`.
- [x] HTTP/2 (hyper h2): `maxConcurrentStreams`, `initialWindowSize`.
- [x] **A1** Rapid-Reset лимит (`maxResetStreamsPerSec` → `max_pending_accept_reset_streams`).
- [x] **h2c prior-knowledge** на plaintext-порту (`h2c: true` → auto-билдер h1+h2).
- [x] **A2** таймауты: `headerReadTimeout` (hyper), `bodyReadTimeout` (→`408`), `idleTimeout` (трекер активности сокета).
- [x] `maxHeaderSize` → `431` (h1 `max_buf_size`, h2 `max_header_list_size`).
- [x] `handshakeTimeout` на TLS-хендшейк; `maxHeaders` (лимит числа заголовков).

**DoD:** ✅ 10 M9-тестов: ALPN согласует h2; h1.1 fallback по ALPN; h2c prior-knowledge; cert из Buffer; Slowloris по `headerReadTimeout`; h2-настройки; `431` по `maxHeaderSize`; `408` по `bodyReadTimeout`; `idleTimeout` закрывает простаивающий keep-alive; `idleTimeout` **не** рвёт долгий запрос. Всего 73 JS + 20 cargo. clippy/fmt чисто.

**Механика idle-таймаута:** `ActivityIo` ([src/idle.rs](src/idle.rs)) оборачивает TCP-сокет **до** TLS и отмечает время последнего чтения/записи; сторожевая задача гасит соединение по `select!`. Счётчик in-flight (RAII-guard вокруг вызова хендлера) исключает ложное срабатывание: долгая обработка без трафика по сокету — не простой.

⚠️ **Отклонения/границы (флаг):**
- **`keepAliveTimeout` отдельной ручкой не вводился.** В DESIGN §6c A2 его нет, а семантику «простой h1 keep-alive между запросами» полностью покрывает `idleTimeout` (он же работает для h2 и TLS). Отдельный knob — только если понадобится разводить эти два случая.
- **Hot-reload сертификатов** — фаза 2 (§12), как и планировалось.
- Нативный CORS/`origin`-функция, TLS client-auth (mTLS) — вне v1.

### Два бага, найденных при доводке M9

1. **`close()` не завершал процесс.** `runtime.shutdown_background()` возвращается сразу и, по документации tokio, **может не уничтожить рантайм вообще** → не дропался `Arc<Shared>` → живы listener (порт занят) и `ThreadsafeFunction` (держит ref на event loop). `npm test` не завершался никогда, а зависшие процессы занимали порты и роняли следующий прогон по `EADDRINUSE`. Исправлено: `shutdown_timeout` в отдельном системном потоке (гарантированный Drop, JS-поток не блокируется) + `notify_one` вместо `notify_waiters` (тот не хранит permit — сигнал терялся, если accept-цикл ещё не дошёл до `notified()`).
2. **h2c молча не работал.** napi-rs конвертирует `h2c` → **`h2C`** (буква после цифры поднимается в верхний регистр); обёртка слала `h2c`, поле терялось, plaintext уходил в h1-only ветку и рвал h2-преамбулу. Исправлено явным `#[napi(js_name = "h2c")]`. **Правило на будущее:** поля с цифрой в середине имени — всегда с явным `js_name`, иначе теряются молча.

---

## M10 — Жизненный цикл сервера / shutdown / overload  ✅
**Цель:** корректная работа под k8s.
**Разделы:** §10, §6c (A3, A4, B7, B9, C5).

Разбит на три подэтапа: **10a жизненный цикл** ✅ · **10b перегрузка** ✅ · **10c сеть/платформа** ✅.

### M10a — Жизненный цикл и graceful shutdown  ✅

- [x] **Graceful shutdown:** сигнал → закрыть listener → `graceful_shutdown` каждому соединению (h2 → `GOAWAY`) → drain in-flight (вкл. JS-хендлеры) → дедлайн `shutdownTimeout` → форс.
- [x] SIGTERM/SIGINT → graceful shutdown → `exit 0`; выключается `{ handleSignals: false }`.
- [x] **`await close()`** — резолвится по окончании drain'а; идемпотентен, параллельные вызовы ждут один drain.
- [x] Server-события: `listening`, `error` (EADDRINUSE → reject + событие), `close`, `shutdown`; `app.on/off`, геттер `app.listening`.
- [x] Конфиг `shutdownTimeout` (дефолт 10с).

**DoD:** ✅ 9 M10a-тестов: порядок событий listening→shutdown→close; занятый порт → reject + событие `error`; `close()` дожидается in-flight; порт свободен сразу после резолва `close()`; идемпотентность и параллельные `close()`; `shutdownTimeout` обрывает застрявший запрос; во время drain'а новые соединения не принимаются; **SIGTERM в дочернем процессе** — in-flight дожат, exit 0; **h2 получает GOAWAY**, текущий стрим дожимается. Всего 82 JS + 20 cargo. clippy/fmt чисто.

**Механика:** сигнал остановки — `watch`-канал, а не `Notify`: его слушают и accept-цикл, и каждое соединение, причём подписчик, пришедший после сигнала, всё равно его видит. Drain детектится дропом клонов `mpsc::Sender` в задачах соединений (`recv() → None`) — без счётчиков. Listener закрывается **до** drain'а: порт свободен для нового пода, пока старый дожимает запросы. `close()` — асинхронный napi-метод, ждёт `done` с собственным дедлайном (`shutdownTimeout + 1с`), чтобы не зависнуть, если сигнал не придёт вовсе.

✅ **Дополнено в M11:** `readiness not-ready` при shutdown подключён, а сама последовательность
остановки стала многостадийной (`preShutdownDelay`) — см. M11, раздел про гонку при shutdown.

### M10b — Перегрузка (C5)  ✅

- [x] **C5 `maxConcurrentRequests`:** слоты через `Semaphore`, permit держится всё время обработки.
- [x] Сверх лимита — `503` + `Retry-After` (значение настраивается).
- [x] Очередь `maxQueue`/`queueTimeout`: короткий всплеск ждёт слот, переполнение отбивается сразу.
- [x] **`GOAWAY` для h2** при отказе (для h1 — закрытие keep-alive после ответа).
- [x] Readiness-shedding при **устойчивой** перегрузке (`overloadShedAfter`); разгрузка возвращает readiness.
- [x] Пробы и метрики идут **мимо лимитера** — под перегрузкой `/readyz` обязан отвечать.

**DoD:** ✅ 8 M10b-тестов: сверх лимита → 503 + `Retry-After`; очередь пропускает всплеск; переполненная очередь отбивает **быстро**, а не через `queueTimeout`; истёкший `queueTimeout` → 503; пробы отвечают под перегрузкой; устойчивая перегрузка снимает readiness, разгрузка возвращает; **h2 получает GOAWAY**; без лимита ничего не отбивается. Плюс 4 cargo unit-теста лимитера. Всего 111 JS + 33 cargo. clippy/fmt чисто.

**Механика:**
- `GOAWAY` реализован через тот же механизм, что и graceful shutdown: обработчик шлёт per-connection `Notify`, а `drive` ловит его наравне с общим сигналом остановки и вызывает `graceful_shutdown()`. Ответ `503` при этом успевает уйти — соединение закрывается уже после него.
- «Устойчивость» перегрузки — отметка начала полосы отказов (`compare_exchange` в атомике); первый же слот, взятый без ожидания, полосу обнуляет. Мгновенный всплеск readiness не трогает.
- Очередь ограничена намеренно: без потолка она превратилась бы под нагрузкой в неограниченный буфер, где клиенты ждут ответа, который уже никому не нужен.

⚠️ **Границы:** лимит считается по **запросам**, а не по стоимости запроса (веса/приоритеты — фаза 2). `Retry-After` — фиксированное число секунд, без экспоненты и джиттера.

### M10c — Сеть и платформа  ✅

- [x] `listen({ port, host })` и **Unix-сокет** (`listen({ path })`); несвежий файл сокета удаляется при старте.
- [x] **A3** `workerThreads: число | 'auto'` — авто читает cgroup CPU-квоту (v2 `cpu.max`, v1 `cfs_quota_us`/`cfs_period_us`), берёт `min(ядра, ceil(квота))`.
- [x] **A4** PROXY protocol v1 (текстовый) и v2 (бинарный) → peer-IP; складывается с `customIpHeaders` (§7: сначала снимаем PROXY, потом смотрим заголовки).
- [x] **B9** socket-опции: `TCP_NODELAY` (по умолчанию вкл.), `SO_REUSEPORT`, `backlog` (по умолчанию 1024), `maxConnections`.

**DoD:** ✅ 10 M10c-тестов: Unix-сокет обслуживает запросы; несвежий файл сокета не мешает старту; PROXY v1 и v2 дают реальный IP; `proxyProtocol` без префикса → соединение закрыто; заголовок приоритетнее PROXY-адреса; `maxConnections` отсекает лишнее; `reusePort` пускает два сервера на один порт; backlog/noDelay/workerThreads принимаются; `'auto'` валиден, мусор → TypeError. Плюс 6 cargo unit-тестов (5 на парсер PROXY, 1 на подбор воркеров). Всего 92 JS + 26 cargo. clippy/fmt чисто.

**Механика:**
- Bind — синхронный, до старта рантайма (ошибки доходят до JS как reject `listen()`), через `socket2` для `backlog`/`SO_REUSEPORT`; регистрация в реакторе tokio — уже внутри рантайма.
- Accept-цикл обобщён на два типа сокета; обслуживание соединения вынесено в `serve_conn<S>` поверх любого `AsyncRead + AsyncWrite`.
- PROXY-префикс читается **до TLS** (он идёт сырым перед хендшейком); остаток буфера отдаётся наверх через `PrefixedIo` — обёртку, доигрывающую «переваренные» байты.
- `maxConnections` — счётчик с RAII-guard (снимается и при панике задачи); сверх лимита сокет закрывается сразу, без задачи.

⚠️ **Отклонения/границы (флаг):**
- **Режим PROXY строгий:** при `proxyProtocol: true` префикс обязателен на каждом соединении. «Мягкий» режим (принять и с префиксом, и без) намеренно не делаем: клиент в обход балансировщика подделал бы себе адрес, просто не отправив префикс.
- **Unix-сокет и `c.req.ip`:** у Unix-пира нет адреса, отдаём `127.0.0.1`, чтобы `c.req.ip` оставался непустым (инвариант §7); реальный источник — из `customIpHeaders` (за unix-сокетом всегда локальный прокси).
- **Multi-port** (health/metrics на отдельном порту) — не сделан здесь: он нужен только вместе с §11, поедет в M11.
- **cgroup-квота на macOS** не проверяется вживую (файлов нет) — есть unit-тест на инвариант «воркеров не больше ядер»; поведение под лимитом проверится на Linux в M13/CI.
- `workerThreads: 'auto'` — поведение по умолчанию (если не задано число).

---

## M11 — Health / observability  ✅
**Цель:** пробы и метрики.
**Раздел:** §11.

- [x] `/healthz` (Rust, мгновенно, до роутинга — JS не будится).
- [x] `/readyz` (Rust): shutdown-aware (`draining`) + `app.setReady()` + `app.setReadinessCheck()` + overload-aware (подключено в M10b).
- [x] `/metrics` Prometheus (Rust): счётчики по методу/классу статуса, гистограмма латентности, in-flight, соединения, байты тел; **отдельный порт** (`health.port`).
- [x] Пути настраиваются (`health.path`/`readyPath`/`metricsPath`), пустая строка = выключить.
- [x] Access-log: JSON-строка на запрос в stdout (`accessLog: true`), пишется из Rust. Структурный `c.log` — сделан в M3.
- [x] **Многостадийный shutdown** (`preShutdownDelay`) — см. ниже.

**DoD:** ✅ 11 M11-тестов: `/healthz` не будит JS (`handlerCalled === false`); `/readyz` реагирует на `setReady`; `setReadinessCheck` снимает готовность при провале; упавший **и зависший** колбэк = не готов; `/metrics` в формате Prometheus со счётчиками по методу/классу; байты тел считаются; отдельный порт (и отсутствие проб на основном); настройка/выключение путей; `preShutdownDelay` (readyz 503, но сервер ещё принимает); дефолт без задержки; access-log в дочернем процессе. Плюс 3 cargo unit-теста (2 метрики, 1 readiness). Всего 103 JS + 29 cargo. clippy/fmt чисто.

### Найдено при написании тестов: гонка при shutdown

Тест «во время shutdown `/readyz` отдаёт 503» падал с `fetch failed` — и это была не ошибка теста. В M10a listener закрывался **сразу** по сигналу, поэтому в окне между SIGTERM и моментом, когда k8s уберёт под из эндпоинтов, уже направленные на под запросы получали connection refused (реальные 502 у пользователей). Классическая гонка graceful shutdown.

Исправлено введением **стадий** остановки (`RUNNING` → `PRE_SHUTDOWN` → `CLOSING`, `watch<u8>` вместо `watch<bool>`):
1. `PRE_SHUTDOWN`: readiness снят (`/readyz` → 503 `draining`), **listener продолжает принимать** `preShutdownDelay`;
2. `CLOSING`: приём прекращён, соединениям идёт `graceful_shutdown` (h2 → `GOAWAY`), дальше drain как раньше.

Соединения реагируют только на `CLOSING`, поэтому в первом окне трафик обслуживается штатно. Дефолт `preShutdownDelay: 0` (прежнее поведение, без сюрпризов в тестах/dev); **под k8s ставить 5–15с**, а `terminationGracePeriodSeconds` — больше, чем `preShutdownDelay + shutdownTimeout`.

⚠️ **Отклонения/границы (флаг):**
- **`status` в метриках — класс (`2xx`/`4xx`), а не точный код.** Точный код дал бы `Mutex<HashMap>` на горячем пути; сейчас всё на атомиках фиксированного массива (метод × класс), без блокировок и аллокаций. Метод вне списка из 8 схлопывается в `other` — защита от кардинальности.
- **Метрик по стримам h2 нет** (§11 упоминал «соединения/стримы») — считаются соединения и запросы; отдельный счётчик стримов потребовал бы хука в hyper.
- **Access-log пишется из Rust напрямую в stdout**, минуя `process.stdout` Node. Порядок относительно `console.log` из JS не гарантирован (разные буферы на одном fd).
- **Readiness-колбэк опрашивается по таймеру** (дефолт 2с), а не на каждый запрос `/readyz`: иначе каждая проба k8s будила бы event loop — ровно то, ради чего пробы живут в Rust. Задержка реакции — до одного интервала.
- **`/readyz` во время drain'а на основном порту** доступен только в окне `preShutdownDelay`; после закрытия listener'а пробу надо смотреть на admin-порту.

---

## M12 — Тестирование и бенчмарки  🟡
**Цель:** качество и цифры.
**Раздел:** §17.

- [x] **`app.inject(req)`** — тест-харнесс без сокета: запрос идёт по `tokio::io::duplex`
      через тот же конвейер (роутинг, схемы, CORS, метрики, JS-луковица). Не мок.
- [x] Тесты утечек/паник: память под нагрузкой выходит на плато; `throw` в каждом запросе не роняет процесс; `unhandledRejection` не срабатывает; оборванные клиентом запросы не копят ресурсы; циклы `listen`/`close`.
- [x] Бенч-харнесс [bench/run.mjs](bench/run.mjs) + отчёт [BENCHMARKS.md](BENCHMARKS.md) с p50/p99/RPS.
- [ ] Интеграционный набор на Node 18/20/22/24 — **в окружении разработки только Node 24**, матрица переезжает в CI (M13).
- [ ] Бенчи внешним генератором (`oha`/`bombardier`/`h2load`) — инструментов в окружении нет; сценарии описаны в BENCHMARKS.md.
- [ ] Сравнение с Fastify и Hono — не установлены; харнесс подхватывает их автоматически, если поставить.
- [ ] Сценарии стриминга/SSE и multipart в бенче.

**DoD (частично):** ✅ 127 JS-тестов + 33 cargo зелёные; отчёт с числами есть. ⬜ Матрица Node LTS и внешние бенчи — CI (M13).

### Главный результат бенчмарков: цена перехода границы

| Сервер | RPS | p50 | p99 |
|---|---:|---:|---:|
| `node:http` | 68 905 | 0.89 ms | 1.78 ms |
| `@oxide-ts/http`, нативная ручка (JS не будится) | 67 869 | 0.89 ms | 1.84 ms |
| `@oxide-ts/http`, JS-хендлер | 39 896 | 1.40 ms | 4.14 ms |

- Нативная ручка и `node:http` дают **одинаковый** результат и не растут при увеличении
  соединений с 64 до 192 → это потолок **клиента**, а не сервера. Реальный запас
  Rust-пути отсюда не виден.
- Разница между нативной ручкой и JS-хендлером — **≈10.6 мкс на запрос** (25.1 против
  14.5 мкс). Это TSFN-вызов, `Promise` через границу, сборка `MatchedRequest`/контекста
  и прогон луковицы.
- **Гипотеза проекта на маршрутах с JS-хендлером пока не подтверждается:** 39.9k против
  68.9k у `node:http`. Выигрыш есть только там, где JS не будится вообще — роутинг,
  `404`/`405`, CORS preflight, отказ по схеме, пробы, `413`/`415`.

### Профиль перехода границы (сделан)

Разбор по слоям — [bench/profile.mjs](bench/profile.mjs); `ELU` — загрузка главного потока.

| Слой | мкс/запрос | ELU | Δ |
|---|---:|---:|---:|
| `native` — JS не будится | 14.98 | 0.000 | — |
| `bridge` — TSFN + `Promise`, колбэк отдаёт константу | 17.42 | 0.976 | +2.44 |
| `touch` — + чтение **всех** полей napi-объекта | 17.23 | ~0.98 | −0.19 |
| `ctx` — + `buildContext`/`buildNativeResponse` | 22.04 | 1.000 | +4.81 |
| `full` — + луковица и хуки | 23.78 | 1.000 | +1.74 |

1. **Маршрут с JS-хендлером упирается в один поток** — ELU ≈ 1.0 даже у минимального
   колбэка, возвращающего константу. Число воркеров tokio на такие маршруты не влияет.
2. **Чтение данных через границу бесплатно:** `touch` читает все поля `MatchedRequest`
   и стоит столько же, сколько вариант, не трогающий их (17.23 против 17.40 — шум).
   Гипотеза о дорогих аллокациях `Vec<KvPair>`/`HashMap` на границе **не подтвердилась**,
   переделывать форму данных не нужно.
3. **Адресуемый резерв — наш JS-слой:** `buildContext` + `buildNativeResponse` (+4.81) и
   луковица (+1.74) = **6.55 мкс**, ~27% времени главного потока. В изолированном
   микро-замере те же функции укладываются в 0.86 мкс — разница на счёт ~25 замыканий,
   нескольких `Map` и крупного литерала, создаваемых на каждый запрос и живущих через
   границу промиса. Размер молодого поколения V8 на результат не влияет (это не GC).
4. **Стратегический вывод:** round-trip через границу — 17.4 мкс главного потока, и это
   пол. `node:http` делает весь запрос за ~14.5 мкс. **Даже обёртка с нулевой стоимостью
   не сделает JS-маршруты быстрее `node:http`.** Преимущество архитектуры — только там,
   где JS не будится (роутинг, `404`/`405`, CORS preflight, отказ по схеме, пробы,
   `413`/`415`/`431`, лимиты, таймауты), плюс неспешностные вещи: backpressure,
   graceful shutdown, метрики и валидация без пробуждения event loop.

Подробности и сырые числа — [BENCHMARKS.md](BENCHMARKS.md).

⚠️ **Методическая заметка:** первая версия харнесса поднимала сервер в том же процессе,
что и генератор нагрузки — JS-хендлер конкурировал с клиентом за event loop, и цифры
занижались почти вдвое (26k вместо 40k). Серверы вынесены в отдельные процессы.

⚠️ **Границы `inject`:** маршруты и схемы компилируются в `listen()`, поэтому первый
`inject` при незапущенном сервере поднимает его на эфемерном порту (`port: 0`); сам
запрос через сокет не идёт. После явного `close()` `inject` бросает ошибку, а не
поднимает сервер заново.

---

## Переход на TypeScript 7

Весь JS-слой переписан на TypeScript (TS 7.0.2, нативный компилятор). Рантайм не изменился —
типы стираются при компиляции; цель была в типобезопасности границы и публичного API.

**Раскладка:**
- Исходники — `js/*.ts` (директория `src/` занята Rust-кодом). Сборка `tsc` → `dist/` (CJS,
  `engines >= 18` не меняется). `main` → `dist/index.js`, `types` → `dist/index.d.ts`.
- **В разработке сборки нет:** тесты и фикстуры — тоже `.ts` и исполняются Node напрямую
  (type stripping). `tsc` запускается только при публикации (`prepublishOnly`).
- Два конфига: [tsconfig.json](tsconfig.json) — сборка (`rootDir: js`), максимальная
  строгость, **0 ошибок**; [tsconfig.test.json](tsconfig.test.json) — проверка тестов.

**Почему не публикуем `.ts` напрямую:** Node отказывается стрипать типы в `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, проверено на Node 24). То есть у потребителя
`require('@oxide-ts/http')` упал бы на любой версии Node — это не компромисс, а неработающий вариант.

**Что типы поймали сразу:**
- Тест, намеренно передающий `workerThreads: 'many'`, перестал компилироваться (пришлось
  пометить `@ts-expect-error`) — ровно тот класс ошибок, который пропустил баг с `h2c`.
- Две слабости собственных сигнатур: rest-параметр в `get/post/...` не давал контекстной
  типизации (`c` выводился как `any`) — добавлены перегрузки; `on('listening', fn)` давал
  `info: never` — добавлена карта типов событий `ServerEventMap`.
- Заодно убрана навеска 11 замыканий-хуков на каждый экземпляр `Server`: именованные хуки
  стали обычными методами прототипа.

⚠️ **Отклонение:** в [tsconfig.test.json](tsconfig.test.json) ослаблены `noImplicitAny`,
`noUnusedLocals`, `noUnusedParameters`, `useUnknownInCatchVariables` — они требовали аннотаций
во внутренних помощниках тестов, не давая ничего взамен. Проверка использования публичного API
сохраняется: контекстная типизация от перегрузок работает независимо от `noImplicitAny`.

---

## M13 — Сборка и доставка (prebuild)  🟡
**Цель:** «работает в любом образе».
**Раздел:** §13.

- [x] Кросс-сборка в docker-образах napi-rs (baseline **glibc 2.17**) для gnu-целей и `lts-alpine` для musl — прописана в CI.
- [x] Шесть целей: `x86_64/aarch64-unknown-linux-{gnu,musl}`, `aarch64/x86_64-apple-darwin`.
- [x] Platform-пакеты (`napi create-npm-dirs`) + `optionalDependencies` в корневом `package.json`.
      Загрузчик с определением musl napi генерирует сам — внешний `detect-libc` не нужен.
- [x] Генерация `.d.ts` — делает napi; JS-слой на TypeScript отдаёт свои типы из `dist/`.
- [x] CI [.github/workflows/ci.yml](.github/workflows/ci.yml): проверки → матрица сборки →
      тесты на Node 18/20/22/24 → установка в чистые образы → публикация по git-тегу.
- [x] Dockerfile'ы [examples/docker/](examples/docker/): `ubuntu`, `ubi9`, `ubi10`, `alpine` —
      ставят только артефакт + `dist/` и гоняют [scripts/smoke.cjs](scripts/smoke.cjs) **без Rust-тулчейна**.
- [ ] Фактический прогон матрицы в GitHub Actions и публикация — требуют самого GitHub и npm-токена.

### Что выяснилось при реальной проверке (а не «на глаз»)

Кросс-сборка и smoke-тесты прогнаны локально в docker, и это вскрыло три вещи,
которых по документации не видно:

1. **`microdnf` нет в полном образе UBI** — он только в `ubi-minimal`. Dockerfile'ы
   для ubi9/ubi10 падали на первом же шаге; переведены на `dnf`.
2. **UBI по умолчанию ставит Node 16** — ниже нашего `engines >= 18`. Smoke проходил,
   потому что N-API 8 ABI-стабилен, но проверял не то, что мы декларируем. Теперь
   в образах явно включается поток `nodejs:20`.
3. **musl-образ napi-rs несёт Node 18, а napi CLI 3.x требует Node 20+**
   (`@inquirer/core` тянет `styleText` из `node:util`) — сборка musl падала до
   компиляции. Обходится вызовом `cargo build` напрямую с переименованием артефакта
   по конвенции napi; `index.js`/`index.d.ts` к тому моменту уже сгенерированы.

**Проверено локально** (сборка в docker-образах napi-rs, release + LTO, затем загрузка
в чистых образах **без Rust-тулчейна** через [scripts/smoke.cjs](scripts/smoke.cjs)):

| Артефакт | Собран | Проверен в | Node |
|---|---|---|---|
| `oxide-http.linux-x64-gnu.node` (7.6 МБ) | `lts-debian`, 5 м 15 с | `ubuntu:22.04` | 22.23.1 |
| то же | | `redhat/ubi9` | 20.20.2 |
| `oxide-http.linux-x64-musl.node` (7.6 МБ) | `lts-alpine`, 8 м 27 с | `node:22-alpine` | 22.23.1 |

arm64-цели и darwin в локальном окружении не проверялись — они собираются на
соответствующих раннерах в матрице CI.

**DoD (частично):** ✅ обе libc-ветки (glibc и musl) собраны и проверены локально в чистых образах
без Rust-тулчейна. ⬜ Зелёный прогон матрицы в CI и `npm i @oxide-ts/http` из реестра — после пуша тега.

**Как устроена публикация:** platform-пакеты публикуются **раньше** корневого (он тянет их через
`optionalDependencies`), все проверки — тег против версии и smoke — идут **до** первой публикации:
npm-релиз необратим, ошибочную версию можно только deprecate.

**Тесты на Node 18/20:** полный набор гоняется на 22+, где Node исполняет `.ts` напрямую.
На 18/20 проверяется то, что и должно — работоспособность **опубликованного артефакта**
(`dist/` + `.node`) на этой версии ABI через smoke-скрипт на CommonJS.

⚠️ **Не сделано намеренно:** windows-цели (в DESIGN были «опционально») — под них нет ни
тестового окружения, ни спроса; Unix-сокеты и cgroup-квота там всё равно неприменимы.

---

## M14 — Документация, примеры, релиз v1.0.0  🟡
**Цель:** готово к использованию.

- [x] [README.md](README.md): быстрый старт, контекст `c`, маршруты, хуки, схемы, `inject`, конфиг-справочник.
- [x] [examples/](examples/): базовый API, схемы (valibot), стриминг/SSE, multipart, middleware/хуки, TLS/h2.
- [x] Пример k8s-манифеста [examples/k8s.yaml](examples/k8s.yaml): пробы на admin-порту, `resources` 1 vCPU (под `workerThreads:'auto'`), `terminationGracePeriodSeconds` > `preShutdownDelay + shutdownTimeout`, HPA.
- [x] [CHANGELOG.md](CHANGELOG.md); `valibot`/`@valibot/to-json-schema` переведены в **опциональные peerDependencies** (долг с M7).
- [ ] Тег `v1.0.0` → публикация в npm — **заблокировано M13**: без prebuild-артефактов `npm i` требует Rust-тулчейн.

**DoD (частично):** ✅ примеры прогнаны и работают; README отражает реальное поведение.
⬜ Smoke-тест `npm i @oxide-ts/http` в чистом образе — после M13.

### Позиционирование в README

Раздел про производительность написан честно и стоит **первым**: на маршрутах с
JS-хендлером библиотека медленнее `node:http` (~40k против ~69k RPS), потому что один
переход границы napi стоит ~17 мкс главного потока против ~14.5 мкс на весь запрос у
`node:http`. Выигрыш сформулирован там, где он реально есть: мусорный и служебный
трафик (роутинг, `404`/`405`, CORS preflight, отказ по схеме, `413`/`415`/`431`/`408`,
`503` при перегрузке, пробы и метрики) не доходит до event loop — ELU 0.000 против 1.0.

### Найдено при написании примеров: `inject` расходился с сетью

Пример с middleware не работал: заголовок `authorization: 'Bearer секрет'` не проходил
проверку. Оказалось — `inject` молча превращал значение с не-ASCII символами в пустую
строку, тогда как реальный `fetch` такой заголовок вовсе отказывается отправлять
(ByteString). Тест-харнесс, ведущий себя не так, как сеть, — ловушка: тест зелёный,
прод падает. `inject` теперь отвергает такие значения с внятной ошибкой; добавлен
регрессионный тест (128 JS-тестов).

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
