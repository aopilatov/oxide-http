# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [SemVer](https://semver.org/lang/ru/).

## [0.1.0] — 2026-07-19

Первый публичный релиз.

Версия `0.x` выбрана намеренно: API ещё не обкатан реальной эксплуатацией, и
ломающие изменения в минорных версиях допустимы. До `1.0.0` дойдём, когда
появится обратная связь.

### Добавлено

**Ядро и мост**
- Сервер на hyper + tokio с собственным рантаймом, отдельным от libuv;
  один переход границы napi на запрос (ThreadsafeFunction ↔ `Promise`).
- Роутинг на matchit в Rust: `404`, `405` + `Allow`, авто-`HEAD`, авто-`OPTIONS`
  и парсинг query — без пробуждения JS.
- Контекст `c` (§7): заголовки, params, query, cookies, `c.req.ip`/`ips`/`country`,
  UUIDv7 `requestId`, структурный логгер `c.log`.

**Тело и стриминг**
- Чтение и запись тела через мост с backpressure в обе стороны.
- `bodyLimit` авторитетен в Rust: считаются фактические байты, `Content-Length`
  не в доверии, обойти из хендлера нельзя.
- Входящая декомпрессия gzip/deflate/br с лимитом по распакованному размеру.
- Multipart (§9a): парсинг в Rust потоково, лимиты и типы файлов проверяются
  до передачи части в JS.

**Композиция**
- Луковица middleware + хуки жизненного цикла Fastify-стиля; цепочки
  предкомпилируются на `listen()`.
- `onError`, `onTimeout`, `c.req.signal` (AbortSignal), инвариант «процесс не падает».

**Схемы**
- valibot либо сырой JSON Schema; структурная валидация и коэрция — в Rust,
  `transform`/`check` доигрывает valibot в JS.
- Отсечение полей ответа по response-схеме.

**Протоколы**
- TLS через rustls, ALPN согласует h2/http1.1; h2c prior-knowledge.
- Настройки HTTP/2, включая лимит Rapid Reset (CVE-2023-44487).
- Read-таймауты против Slowloris; `maxHeaderSize` → `431`, `bodyReadTimeout` → `408`.

**Жизненный цикл и эксплуатация**
- Многостадийный graceful shutdown: readiness снимается → listener ещё принимает
  `preShutdownDelay` → приём прекращается, h2 получает `GOAWAY` → drain до
  `shutdownTimeout`. SIGTERM/SIGINT → `exit 0`.
- Server-события `listening`/`error`/`close`/`shutdown`, `await close()`.
- Unix-сокет, socket-опции (`backlog`, `SO_REUSEPORT`, `TCP_NODELAY`,
  `maxConnections`), PROXY protocol v1/v2, `workerThreads: 'auto'` по cgroup-квоте.
- Защита от перегрузки: лимит одновременных запросов, очередь, `503` + `Retry-After`,
  `GOAWAY` для h2, снятие readiness при устойчивой перегрузке.
- `/healthz`, `/readyz`, `/metrics` (Prometheus) — целиком в Rust, опционально на
  отдельном порту; JSON access-log.

**Разработка**
- `app.inject()` — тест-харнесс без сокета через тот же конвейер.
- JS-слой на TypeScript; типы публичного API и границы с Rust.

### Известные ограничения

- На маршрутах с JS-хендлером сервер **медленнее** `node:http` (~40k против ~69k RPS):
  переход границы napi стоит ~17 мкс главного потока против ~14.5 мкс на весь запрос
  у `node:http`. Выигрыш — только там, где JS не будится. См. [BENCHMARKS.md](BENCHMARKS.md).
- Один параметр на сегмент пути (`/{id}.{ext}` не поддерживается).
- WebSocket не поддерживается и не планируется.
- Динамическая origin-функция в нативном CORS отсутствует — пишется JS-middleware.
- В метриках статус — класс (`2xx`/`4xx`), а не точный код.
- Hot-reload TLS-сертификатов, нативный сериализатор ответа, рекурсивное отсечение
  вложенных полей — фаза 2.
