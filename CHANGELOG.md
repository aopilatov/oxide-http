# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Native response cache** (DESIGN §18): `app.get('/hot', { cache: '5s' }, handler)` —
  the first response is stored in Rust and identical requests are answered without
  waking JS until the TTL expires (ELU on a hit-only load: 0.000). Key = method + path +
  query (+ body hash for `QUERY`) + optional `vary` request headers. Only `200`,
  non-streamed responses without `Set-Cookie`/`no-store`/`private` are stored;
  `maxEntries` (1024) and `maxBodyBytes` (1 MiB) bound the memory. Hits carry
  `x-cache: hit` and keep their own `x-request-id`. `app.purgeCache(path?)` invalidates;
  `/metrics` gains `http_cache_hits_total`/`http_cache_misses_total`.
- **The HTTP `QUERY` method** (draft-ietf-httpbis-safe-method-w-body): `app.query(path,
  ...)`. The body works exactly like a POST body (streaming, native schema validation,
  limits); `405`/`Allow`, auto-`OPTIONS` and the CORS defaults advertise it; the cache
  treats it as safe with the body folded into the key.

## [0.2.0] — 2026-07-20

A security and correctness pass over the whole codebase ([FIXES.md](FIXES.md) tracks the
audit it came from), plus a performance rework of the JS wrapper. Several defaults
changed and a few APIs are stricter — on `0.x` that is allowed, but read the breaking
list before upgrading.

### Performance

- **JS-handler routes: 39.9k → 60.7k RPS (+52%)** on the reference benchmark; the wrapper
  above the raw bridge now costs ~0.6 µs per request instead of ~7.9 µs (see
  [BENCHMARKS.md](BENCHMARKS.md)).
- The context `c` was rewritten onto class prototypes: no more ~25 closures per request.
  Derived views — header map, `query`/`queries`, cookies, the logger, the store,
  `ResHeaders` (with the request-id echo), the `AbortSignal` — are built lazily on first
  access. Public API and behaviour are unchanged.
- Per-leaf context options are precompiled at `listen()`; the `AbortController` is only
  allocated when a timeout or disconnect watcher needs it; empty hook stages are skipped;
  routes without middleware bypass the onion entirely.

### Security

- **CORS: `origin: '*'` together with `credentials: true` is now refused at startup.**
  Honouring it required reflecting the caller's `Origin`, which let *any* site make
  credentialed requests and read the responses — the Same-Origin Policy stopped applying.
  List the origins you trust instead.
- **A request body cut short is no longer indistinguishable from a complete one.** A read
  error part-way through used to look like a clean end of body, so a handler received half
  an upload and treated it as whole. It is now `400`.
- The PROXY protocol prefix read is bounded by `handshakeTimeout`. It happens before TLS
  and before the idle watchdog exists, so a client that connected and stayed silent held a
  task and a file descriptor indefinitely.
- Protective timeouts now have defaults: `headerReadTimeout` and `bodyReadTimeout` `'30s'`,
  `idleTimeout` `'75s'`, `handshakeTimeout` `'10s'`. Previously a client could trickle a
  body forever and keep-alive connections were never reclaimed.
- The admin port (`health.port`) is hardened like the main one: it had no timer, so not
  even hyper's default header-read timeout applied, and nothing reclaimed idle sockets.
- `/metrics` is no longer served on the main port unless asked for.

### Added

- `onAbort` now actually fires, and `c.req.signal` is aborted, when the client disconnects
  before a response is produced. Both were registrable but inert. Watching costs a pending
  promise per request, so it is enabled by registering an `onAbort` hook, or explicitly via
  `detectDisconnect: true`.
- `installSafetyNet: false` opts out of the process-wide `unhandledRejection` handler; it
  is also skipped automatically when the application registered its own.
- `bodyLimit: null` disables the body limit (there was previously no way to reach the
  native "no limit" state).

### Fixed

- A compressed request body on a route with `schema.body` was rejected with
  `400 body is required`: it skipped native buffering, so the validator saw no body at all.
  `gzip`/`deflate`/`br` are now decoded in Rust before validation, bounded by `bodyLimit`
  so a zip bomb is refused rather than expanded.
- `multipart: false` switched multipart *on* with default limits.
- Cookie header fields split across several lines (permitted for HTTP/2 by RFC 9113 §8.2.3)
  were rejoined with `", "` instead of `"; "`, so every cookie after the first was lost.
- A malformed percent-escape in a cookie (`x=%zz`) failed the whole request with `500`.
- Malformed JSON in `c.req.json()` returned `500`; it is now `400`. An unrecognised
  `Content-Encoding` passed through undecoded and failed later; it is now `415`.
- Calling `listen()` twice on one instance silently dropped the running server, destroying
  a tokio runtime on Node's event-loop thread and cutting live connections with no drain.
- With several servers in one process, SIGTERM made each drain independently and call
  `process.exit()`, so the first to finish killed the others mid-drain.
- `route(prefix, sub)` copied the sub-app on the spot, silently discarding anything
  registered on it afterwards.
- Streamed response bodies were missing from `http_response_body_bytes_total`.
- The access log wrote to stdout inline, blocking a tokio worker for as long as the log
  consumer took to read.
- A connection could take up to twice `idleTimeout` to be reclaimed after a request ended.
- The readiness-check timeout timer was never cleared, keeping the process alive for up to
  `timeout` after `close()`.
- Negative count options (`maxConnections: -1` and friends) were silently dropped, turning
  a typo into "no limit"; they are now a config error.
- Concurrent `inject()` calls on a not-yet-started server raced each other into
  "already listening" whenever any route had a schema. The auto-start is now shared.
- An explicit `bodyLimit: undefined` disabled the limit instead of applying the default;
  only `null` disables it.
- Retrying `listen()` on another port after `EADDRINUSE` registered a second copy of the
  valibot validation hook.
- `c.req.stream` yielded decoded bytes on a route with a schema and the raw compressed
  bytes on one without. It now always yields exactly what the client sent, on every route;
  `text()`, `json()` and `arrayBuffer()` decode.
- Request bodies buffered for schema validation were missing from
  `http_request_body_bytes_total`.
- The probe-collision check compared pattern strings, so a parametric route like `/:page`
  passed `listen()` and was then shadowed by `/healthz` at runtime. Probe paths are now
  matched through the router.

### Changed (breaking)

1. `cors: { origin: '*', credentials: true }` throws at construction.
2. `/metrics` is off on the main port by default — set `health.metricsPath` or
   `health.port`.
3. Registering a route on an enabled probe path fails `listen()` instead of being silently
   shadowed by the native probe.
4. `headerReadTimeout`, `bodyReadTimeout` and `idleTimeout` now have defaults; pass `0` to
   disable one explicitly.
5. A truncated request body raises `400` where handlers previously received a short body.
6. An unknown `Content-Encoding` is `415` and malformed JSON is `400`, both previously `500`.
7. `schema.body` on a multipart route fails `listen()`.
8. `onConnect` and `onClose` are removed. They could only be honoured by waking JS once per
   connection, which is what serving connections in Rust exists to avoid.
9. `listen()` throws if the instance is already listening, or was closed.
10. `route(prefix, sub)` folds the sub-app in at `listen()`, so late registrations on it now
    take effect.

### Dependencies

- Added `flate2` and `brotli` (both pure Rust, so musl and cross builds are unaffected).

## [0.1.1] — 2026-07-19

Documentation only — no code changes, the published binaries are identical to `0.1.0`.

### Changed

- All documentation and source comments are now in English: `README.md`, `DESIGN.md`,
  `CHANGELOG.md`, `BENCHMARKS.md`, the Rust and TypeScript sources, the tests, the examples
  and the CI workflow.
- Removed `IMPLEMENTATION.md` — the milestone plan it tracked is complete, and the
  architecture it duplicated lives in [DESIGN.md](DESIGN.md).

## [0.1.0] — 2026-07-19

First public release.

The `0.x` line is deliberate: the API has not been shaped by real-world use yet, so
breaking changes in minor versions are allowed. `1.0.0` will come once there is feedback
from actual deployments.

### Added

**Core and bridge**
- A server on hyper + tokio with its own runtime, separate from libuv; one napi boundary
  crossing per request (ThreadsafeFunction ↔ `Promise`).
- matchit-based routing in Rust: `404`, `405` + `Allow`, auto-`HEAD`, auto-`OPTIONS` and
  query parsing all happen without waking JS.
- The context `c` (§7): headers, params, query, cookies, `c.req.ip`/`ips`/`country`,
  a UUIDv7 `requestId`, and the structured logger `c.log`.

**Bodies and streaming**
- Reading and writing bodies across the bridge with backpressure in both directions.
- `bodyLimit` is authoritative in Rust: actual bytes are counted, `Content-Length` is not
  trusted, and the limit cannot be bypassed from a handler.
- Inbound gzip/deflate/br decompression with the limit applied to the decompressed size.
- Multipart (§9a): streaming parsing in Rust, with limits and file types checked before a
  part reaches JS.

**Composition**
- A middleware onion plus Fastify-style lifecycle hooks; chains are precompiled on
  `listen()`.
- `onError`, `onTimeout`, `c.req.signal` (AbortSignal), and the "process stays up" invariant.

**Schemas**
- valibot or raw JSON Schema; structural validation and coercion happen in Rust, while
  valibot applies `transform`/`check` in JS.
- Response field stripping by the response schema.

**Protocols**
- TLS via rustls with ALPN negotiating h2/http1.1; h2c prior-knowledge.
- HTTP/2 settings, including the Rapid Reset limit (CVE-2023-44487).
- Read timeouts against Slowloris; `maxHeaderSize` → `431`, `bodyReadTimeout` → `408`.

**Lifecycle and operations**
- Multi-stage graceful shutdown: readiness drops → the listener keeps accepting for
  `preShutdownDelay` → accepting stops, h2 receives `GOAWAY` → drain until
  `shutdownTimeout`. SIGTERM/SIGINT → `exit 0`.
- Server events `listening`/`error`/`close`/`shutdown`, and `await close()`.
- Unix sockets, socket options (`backlog`, `SO_REUSEPORT`, `TCP_NODELAY`,
  `maxConnections`), PROXY protocol v1/v2, `workerThreads: 'auto'` from the cgroup quota.
- Overload protection: a concurrent request limit, a queue, `503` + `Retry-After`,
  `GOAWAY` for h2, and readiness shedding under sustained overload.
- `/healthz`, `/readyz`, `/metrics` (Prometheus) answered entirely in Rust, optionally on
  a separate port; a JSON access log.

**Development**
- `app.inject()` — a socket-free test harness running the very same pipeline.
- The JS layer is written in TypeScript, with types for the public API and the Rust boundary.

### Known limitations

- On routes handled in JS the server is **slower** than `node:http` (~40k vs ~69k RPS):
  crossing the napi boundary costs ~17 µs of main-thread time against ~14.5 µs for an
  entire request in `node:http`. The win only exists where JS never wakes. See
  [BENCHMARKS.md](BENCHMARKS.md).
- One parameter per path segment (`/{id}.{ext}` is not supported).
- WebSocket is not supported and not planned.
- No dynamic origin function in the native CORS — write a JS middleware instead.
- In metrics the status is a class (`2xx`/`4xx`), not the exact code.
- TLS certificate hot-reload, a native response serializer and recursive stripping of
  nested fields are phase two.
