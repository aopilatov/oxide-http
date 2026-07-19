# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [SemVer](https://semver.org/).

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
