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

Файлы: [src/cors.rs](src/cors.rs) (политика CORS), [src/server.rs](src/server.rs) (`handle` с краями + `apply_cors`), [src/lib.rs](src/lib.rs) (`CorsOptions`), [js/index.js](js/index.js) (`normalizeCors`).

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

Файлы: [src/schema.rs](src/schema.rs) (компиляция/коэрция/валидация), [js/schema.js](js/schema.js) (конвертация/valibot/стрип), [src/server.rs](src/server.rs) (буферизация+валидация в dispatch), [js/context.js](js/context.js) (`c.req.valid`, стрип), [js/index.js](js/index.js) (route-схемы, синтетический `preValidation`).

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

Файлы: [src/multipart.rs](src/multipart.rs) (парсер, лимиты, типы), [src/stream.rs](src/stream.rs) (`BodyIo.nextPart/readPart`, `PartMeta`), [src/server.rs](src/server.rs) (415/boundary/spawn в dispatch), [js/context.js](js/context.js) (`c.req.parts/formData`), [js/index.js](js/index.js) (`normalizeMultipart`).

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

## M10 — Жизненный цикл сервера / shutdown / overload  🟡
**Цель:** корректная работа под k8s.
**Разделы:** §10, §6c (A3, A4, B7, B9, C5).

Разбит на три подэтапа: **10a жизненный цикл** ✅ · **10b перегрузка** ⬜ · **10c сеть/платформа** ✅.

### M10a — Жизненный цикл и graceful shutdown  ✅

- [x] **Graceful shutdown:** сигнал → закрыть listener → `graceful_shutdown` каждому соединению (h2 → `GOAWAY`) → drain in-flight (вкл. JS-хендлеры) → дедлайн `shutdownTimeout` → форс.
- [x] SIGTERM/SIGINT → graceful shutdown → `exit 0`; выключается `{ handleSignals: false }`.
- [x] **`await close()`** — резолвится по окончании drain'а; идемпотентен, параллельные вызовы ждут один drain.
- [x] Server-события: `listening`, `error` (EADDRINUSE → reject + событие), `close`, `shutdown`; `app.on/off`, геттер `app.listening`.
- [x] Конфиг `shutdownTimeout` (дефолт 10с).

**DoD:** ✅ 9 M10a-тестов: порядок событий listening→shutdown→close; занятый порт → reject + событие `error`; `close()` дожидается in-flight; порт свободен сразу после резолва `close()`; идемпотентность и параллельные `close()`; `shutdownTimeout` обрывает застрявший запрос; во время drain'а новые соединения не принимаются; **SIGTERM в дочернем процессе** — in-flight дожат, exit 0; **h2 получает GOAWAY**, текущий стрим дожимается. Всего 82 JS + 20 cargo. clippy/fmt чисто.

**Механика:** сигнал остановки — `watch`-канал, а не `Notify`: его слушают и accept-цикл, и каждое соединение, причём подписчик, пришедший после сигнала, всё равно его видит. Drain детектится дропом клонов `mpsc::Sender` в задачах соединений (`recv() → None`) — без счётчиков. Listener закрывается **до** drain'а: порт свободен для нового пода, пока старый дожимает запросы. `close()` — асинхронный napi-метод, ждёт `done` с собственным дедлайном (`shutdownTimeout + 1с`), чтобы не зависнуть, если сигнал не придёт вовсе.

⚠️ **Границы:** `readiness not-ready` при shutdown — часть §11 (M11), появится вместе с `/readyz`; сейчас shutdown его не трогает.

### M10b — Перегрузка (C5)  ⬜

- [ ] **C5 `maxConcurrentRequests`:** счётчик in-flight; `503`+`Retry-After`(+`GOAWAY` h2) сверх лимита; очередь `maxQueue`/`queueTimeout`; readiness-shedding при устойчивой перегрузке.

**DoD:** тесты: перегрузка→503+Retry-After; readiness падает под нагрузкой.

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
