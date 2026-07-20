# Fix plan — code audit 2026-07-20

Findings from a full read of `src/*.rs` and `js/*.ts` at v0.1.1, grouped into four
stages. Stages land one at a time, each with its own confirmation before starting.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done

**Progress:** 11 / 26 items · Stage B complete, awaiting confirmation for Stage C

| Stage | Theme | Items | Done |
| --- | --- | --- | --- |
| A | Security — blocks release | 6 | 6 |
| B | Data correctness | 5 | 5 |
| C | Lifecycle and public API | 6 | 0 |
| D | Observability and cleanups | 9 | 0 |

Verification after Stage B: `cargo clippy -- -D warnings` clean, 38 Rust unit tests pass,
140 JS tests pass (`npm test`), `npm run typecheck` clean.

The B3 and B4 tests were checked against the un-fixed code and each fails without its fix,
so they genuinely pin the bug rather than passing by construction.

---

## Stage A — Security (blocks release) — **done 2026-07-20**

### [x] A1 — CORS: reject `*` together with `credentials`

With `origins: ['*']` and `credentials: true`, `resolve_origin` reflects the caller's
Origin and pairs it with `Access-Control-Allow-Credentials: true`. Any website can then
make cookie-bearing requests and read the responses — Same-Origin Policy is gone. The
spec forbids `*` with credentials for exactly this reason.

- Throw a `TypeError` from `normalizeCors` in `js/index.ts:836` when `credentials` is
  true and origins contain `'*'`.
- Drop the reflect branch in `src/cors.rs:44` (unreachable afterwards) — return `None`.
- The `!self.any_origin` guard on `Vary: Origin` (`src/cors.rs:83`, `src/cors.rs:101`)
  becomes correct on its own once reflection is gone; no separate change needed.
- Update the `any_origin_with_credentials_echoes` unit test to assert rejection.

Breaking: `origin: '*', credentials: true` will no longer start.

Done as planned. The integration test at `__test__/cors.test.ts:96` asserted the old
reflecting behaviour and now asserts the constructor throws.

### [x] A2 — A dropped connection must not look like end-of-body

`let Some(Ok(frame)) = next else { break }` collapses a genuine EOF and a read error
into "body finished". JS sees `null` from `read()` and treats a truncated body as
complete — silent data corruption for uploads and proxied payloads.

- Add `BodyMsg::Aborted` and a `BODY_READ_ABORTED` marker in `src/stream.rs`.
- Expand the pattern into an explicit `match` in `src/server.rs:1004` (`read_body_task`)
  and `src/server.rs:1050` (`buffer_body`): `None` ends the body, `Some(Err(_))` sends
  `Aborted` / returns a new `BodyErr::Aborted` → 400.
- Add `isAbortError` next to `isLimitError` in `js/context.ts:204`, mapped to
  `HttpError(400, 'Request body aborted')`.
- Test: client closes the socket mid-body; the handler must see an error, not a short
  buffer.

Done as planned. The new test is `A2:` in `__test__/streaming.test.ts` — it asserts on
what the handler saw, since the client is gone before a response could be observed.

### [x] A3 — Timeout on the PROXY prefix read

`proxy_protocol::read_header` runs before the stream is wrapped in `ActivityIo` and
before the idle watchdog starts in `drive`; `handshake_timeout` only covers TLS. A
client that connects and stays silent holds a task and an FD forever.

- Wrap the call at `src/server.rs:346` in
  `tokio::time::timeout(tuning.handshake_timeout, ...)`.
- Note in the `handshakeTimeout` doc comment that it also covers the PROXY prefix.

Done. `handshake_timeout` became `Option<Duration>` as part of A4, so both this call site
and the TLS one now go through a new `maybe_timeout` helper in `src/server.rs`.

### [x] A4 — Default body and idle timeouts

Headers are covered by hyper's 30s default, but `bodyReadTimeout` and `idleTimeout`
default to `None` (`src/lib.rs:302`). Out of the box a client can trickle a body forever
and keep-alive connections never close.

- Defaults: `bodyReadTimeout = 30s`, `idleTimeout = 75s` (above the usual ALB/nginx
  keep-alive so the upstream closes first), `headerReadTimeout = 30s` set explicitly
  rather than inherited from hyper.
- Fix the meaning of zero in `ms()` (`src/lib.rs:266`): `0` currently becomes
  `Duration::ZERO`, an instant timeout. It must mean "disabled" (`None`), and a negative
  value must be a config error instead of being silently dropped.

Done. The `ms` closure was replaced by two helpers in `src/lib.rs`: `timeout_ms`
(protective — `0` disables, negative errors) and `delay_ms` (literal — `0` means zero),
because the two families need different semantics for zero. `handshake_timeout` moved to
`Option<Duration>` for consistency.

Worth knowing: negative values never actually reached Rust from JS — `parseUnit` in
`js/units.ts` already threw on them. The native check is defence in depth for a direct
addon call, so the test asserts the constructor throw, which is the reachable path.

### [x] A5 — Harden the admin port

`serve_admin` (`src/server.rs:442`) uses a bare `http1::Builder::new()`: no `.timer()`,
so not even hyper's default header timeout applies, plus no idle timeout and no
connection cap. Slowloris from inside the cluster parks unlimited tasks.

- Use `build_h1(&shared.tuning)` instead of the bare builder.
- Wrap the stream in `ActivityIo` and apply `idle_timeout`.
- Count admin connections against `max_connections`.
- Metrics and graceful drain stay out of scope — the port is internal.

Done. Admin connections now go through the same `drive()` as the main port, so they also
honour graceful shutdown — that came for free rather than being skipped.

### [x] A6 — `/metrics` is not public by default

`HealthPaths::default` (`src/health.rs:19`) serves `/metrics` on the main port whenever
`health.port` is unset, contradicting the design goal of keeping it off the public
surface. The probe paths also silently shadow user routes.

- Default `metrics_path` to `""`. Metrics turn on via an explicit `health.metricsPath`,
  or automatically on the admin port when `health.port` is set.
- At `listen()`, fail with a clear error if any registered route collides with an
  enabled health path.

Breaking: `/metrics` disappears from the main port unless configured.

Done, with one refinement: `HealthPaths::default()` still returns the canonical paths
(one source of truth for the names) and `src/lib.rs` decides whether the metrics default
applies, based on `admin_port`.

The collision check is a second breaking change worth calling out separately in the
CHANGELOG: `M11: /healthz answers 200 without waking JS` used to *rely* on shadowing —
it registered a `/healthz` route and asserted the handler never ran. It now proves the
same property with a global middleware plus `notFound`, which is a stronger check.

---

## Stage B — Data correctness — **done 2026-07-20**

### [x] B1 — Compressed body plus a body schema returns 400

`buffer_for_schema` excludes compressed bodies (`src/server.rs:894`), so
`schema.validate()` receives `body: None` and reports "body is required"
(`src/schema.rs:114`). A client sending a valid gzipped payload is rejected before JS
runs. The JS fallback at `js/index.ts:917` is dead code — it never gets reached.

- Add `flate2` (rust_backend / miniz_oxide) and `brotli` — both pure Rust, so musl
  cross-compilation is unaffected.
- Remove `&& !compressed` from the `buffer_for_schema` condition; decompress after
  buffering, bounded by `body_limit` (this also caps zip bombs).
- Status mapping: decompression failure → 400, over the limit after decompression → 413,
  unknown `Content-Encoding` → 415.
- Add `body_decoded: bool` to `MatchedRequest`; `decompress` in `js/context.ts:235`
  skips its work when the flag is set. Leave the `content-encoding` header untouched so
  `c.req.header()` still reports what the client actually sent.
- A body schema on a multipart route is a config error — catch it at `listen()`.
- Test: gzipped body **with** a schema. The existing gzip test has no schema and misses
  this path entirely.

Done as planned. Decoding lives in a new `src/compress.rs` with its own unit tests
(round-trips, unsupported/malformed encodings, and a zip bomb stopped at the limit).
`x-gzip` is accepted as an alias on both sides. `deflate` is read as zlib-wrapped to match
`zlib.inflateSync` in JS — the same request must behave the same with or without a schema.

Follow-up worth noting: the `c.req.json()` fallback inside `injectValidation`
(`js/index.ts`) is now effectively unreachable, since Rust pre-validates every schema'd
body including compressed ones. Left in place as a safety net, comment corrected.

### [x] B2 — `multipart: false` turns multipart on

`opts.multipart != null` (`js/index.ts:372`) lets `false` through to
`normalizeMultipart`, which returns `{}` with default limits.

- Change the guard to `opts.multipart != null && opts.multipart !== false`.
- Drop the `mp === false` branch in `normalizeMultipart` (`js/index.ts:873`).

Done. `normalizeMultipart` now takes `true | MultipartConfig`, so the type system rules
out the dead branch rather than leaving it as unreachable code.

### [x] B3 — HTTP/2 cookie headers are joined with the wrong separator

`buildReqHeaders` (`js/context.ts:407`) joins duplicates with `', '`. RFC 9113 §8.2.3
lets h2 clients split `cookie` across several header fields and requires rejoining with
`'; '`. Today everything after the first cookie is lost or mangled — and the server
supports h2 over ALPN and h2c.

- Join with `'; '` for `cookie`, `', '` for everything else.
- Test over h2c with several cookie header fields.

Done, but tested over HTTP/1.1 with a raw socket instead of h2c: Node's http2 client
normalises an array of cookie values into a single field before sending, which would have
made the test assert nothing. Two `Cookie:` lines over h1 reach `buildReqHeaders` as the
same two `KvPair`s an h2 client would produce, so it exercises the identical code path
deterministically.

### [x] B4 — A malformed percent-escape in a cookie returns 500

`decodeURIComponent` (`js/context.ts:426`) throws `URIError` on `Cookie: x=%zz`, so any
`c.req.cookie()` call on such a request fails the whole request.

- Wrap in try/catch and fall back to the raw value.

Done as planned. Other cookies in the same header keep parsing normally.

### [x] B5 — Client body errors return 500 instead of 4xx

- `c.req.json()` (`js/context.ts:547`): catch `SyntaxError` →
  `HttpError(400, 'Invalid JSON body')`.
- `decompress` (`js/context.ts:243`): an unknown `Content-Encoding` currently passes
  through and then fails during parsing → return `HttpError(415)` instead.

Done. Both statuses now match what Rust returns for the same input on a schema'd route,
so the response does not depend on whether the route happens to have a schema.

---

## Stage C — Lifecycle and public API

### [ ] C1 — Wire up `onAbort` and client-disconnect detection

`onAbort` is registrable but never fires, and `c.req.signal` only aborts on timeout
despite being documented as "timeout/disconnect" (`js/context.ts:111`).

- Add a Drop guard in `handle` (`src/server.rs:532`) that fires an `Arc<Notify>` when
  hyper drops the service future (the client went away).
- Add a napi method `waitAbort(): Promise<void>` on `BodyIo` awaiting that `Notify`.
- In `#dispatch` (`js/index.ts:786`), subscribe and on fire set `c.aborted = true`, call
  `controller.abort()`, and run `chain.onAbort`.
- Gate the subscription on `chain.onAbort.length > 0` or a new `config.detectDisconnect`
  so there is no pending promise per request by default.

### [ ] C2 — Remove `onConnect` / `onClose` — **decided: remove**

Both are registrable and never fire. Implementing them honestly means waking JS per
connection, which contradicts the core design (connections are served in Rust). No test
references them.

- Remove from `OTHER_STAGES` (`js/pipeline.ts:31`), which drops them from `StageName`
  and `Chain`.
- Remove the `onConnect` / `onClose` methods (`js/index.ts:514`).
- Update the hook table in `DESIGN.md:186` and `DESIGN.md:202`.

Breaking: both methods disappear from the public API.

### [ ] C3 — Guard against a second `listen()`

`*self.state.lock().unwrap() = Some(...)` (`src/lib.rs:435`) silently drops the previous
`Running`, destroying a tokio Runtime on Node's event-loop thread and cutting the first
server's connections without a graceful drain.

- Return an error from `listen` (`src/lib.rs:214`) when `state` is already `Some`.
- Check `#listening` and `#closed` in the wrapper (`js/index.ts:552`).

### [ ] C4 — One signal handler per process

Every `Server` instance installs its own SIGTERM handler calling `process.exit(0)`
(`js/index.ts:763`), so with several servers the first one to finish kills the process
before the others drain.

- Use a module-level registry: install a single handler that closes every live instance,
  then exits.

### [ ] C5 — Stop swallowing unrelated unhandled rejections

`installSafetyNet` (`js/index.ts:220`) intercepts every unhandled rejection in the
process and replaces Node's default crash with a stderr line, so an application can keep
running with broken logic.

- Make it configurable (`config.installSafetyNet`, default `true` for compatibility) and
  skip installation when the application already registered its own handler.

### [ ] C6 — `route(prefix, sub)` snapshots instead of referencing

Routes are copied at call time (`js/index.ts:524`), so anything added to the sub-app
afterwards is silently lost.

- Keep a reference to the sub-app and expand it during `listen()`.

---

## Stage D — Observability and cleanups

### [ ] D1 — `bodyLimit` cannot be disabled

`config.bodyLimit ?? '10mb'` (`js/index.ts:283`) means `undefined` yields the default and
there is no way to reach the `None` the Rust side supports. Distinguish "not provided"
(default 10mb) from an explicit `null` (no limit) via `'bodyLimit' in config`.

### [ ] D2 — `response_bytes` ignores streamed responses

Only the buffered path counts (`src/server.rs:1203`). Count bytes in
`ChannelBody::poll_frame` (`src/stream.rs:195`) as well.

### [ ] D3 — The access log blocks a worker thread

`println!` (`src/server.rs:651`) writes synchronously from a tokio worker; a slow log
consumer throttles request handling. Move to an mpsc channel with a dedicated writer
thread.

### [ ] D4 — Race in `maxConnections`

Check-then-increment (`src/server.rs:250`) lets concurrent accepts overshoot the limit.
Use `fetch_add` with rollback.

### [ ] D5 — `watch_idle` overshoots while a request is in flight

It sleeps a whole interval (`src/idle.rs:76`), so an actual close can take up to
2 × `idleTimeout`. Poll more frequently.

### [ ] D6 — `setReadinessCheck` timeout timer is never cleared

The inner `setTimeout` (`js/index.ts:738`) is not cleared or unref'd and can keep the
process alive for up to a second after `close()`.

### [ ] D7 — Document the XFF trust model

`client_ip_country` takes the leftmost entry (`src/server.rs:1127`), which the client
supplies when a proxy appends rather than overwrites. README must state that
`customIpHeaders` is only trustworthy behind a proxy that overwrites the header.

### [ ] D8 — Negative durations and sizes are silently ignored

`ms()` filters `n >= 0` (`src/lib.rs:266`), so a typo like `bodyReadTimeout: -5000`
quietly disables the protection. Folded into A4 for the timeout path; this item covers
the remaining size/count options.

### [ ] D9 — CHANGELOG entry for the breaking changes

Collect every breaking change from this plan into one release note.

---

## Breaking changes introduced by this plan

Acceptable on 0.x, but they all need a CHANGELOG entry (D9):

1. `origin: '*'` with `credentials: true` now fails at startup (A1).
2. `/metrics` is off by default on the main port (A6).
3. A route on an enabled probe path now fails `listen()` instead of being shadowed (A6).
4. Body, idle and header timeouts now have defaults; `0` disables a timeout (A4).
5. A truncated request body now raises 400 instead of reading as a complete short body
   (A2) — handlers that silently accepted partial uploads will start seeing errors.
6. An unknown `Content-Encoding` is now `415` and malformed JSON in `c.req.json()` is
   `400`; both used to surface as `500` (B5).
7. `schema.body` on a multipart route now fails `listen()` (B1).
8. `onConnect` / `onClose` removed from the public API (C2).
9. A second `listen()` on the same instance now throws (C3).

New runtime dependencies: `flate2` and `brotli`, both pure Rust (B1).

## Decisions

- **2026-07-20 — C2:** remove `onConnect` / `onClose` rather than keeping them behind an
  opt-in. Per-connection JS wakeups contradict the design.
