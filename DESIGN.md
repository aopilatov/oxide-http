# A Rust-based HTTP/HTTP2 server for Node.js — design document

Status: draft v1 (the key decisions are settled)
Date: 2026-07-03

## 1. Goal

A fast HTTP/1.1 + HTTP/2 server for Node.js, implemented as a **native Rust addon**
(napi-rs). The protocol, TLS, parsing and routing live in Rust and spread across all cores;
JS is left with application logic only (async API handlers and middleware). The target load
profile is an **I/O-bound JSON API** (databases, external services), with no server-side
rendering. Deployed to **Kubernetes**.

## 2. Key decisions (summary)

| # | Decision | Choice |
|---|---|---|
| 0 | Name | The package **`@oxide-ts/http`**, the class **`Server`** |
| 1 | Node integration | A native addon (**napi-rs**), a `.node` inside the Node process |
| 2 | Public API | Our own minimal one (Hono-like), **not** a drop-in `node:http` |
| 3 | TLS | Terminated in Rust (**rustls**), ALPN → h2 / http1.1 |
| 4 | Async handlers | Yes (return a `Promise`, `await` the result at the bridge) |
| 5 | JS parallelism | **One** JS thread (the event loop). Scale with k8s replicas, ~1 vCPU/pod |
| 6 | Routing | In Rust on **`matchit`** (radix tree) |
| 7 | Router features | static, `:param`, a trailing catch-all. **No**: mid-path wildcard, optional params, regex constraints, several params in one segment (a matchit limitation — see §5) |
| 8 | Middleware | An "onion" with `next()` (code before and after), driven from Rust |
| 9 | The context `c` | Canonical **in JS** (a plain object); `set/get` and `c.res` never cross the boundary |
| 10 | Native middleware in v1 | **body-limit + cors + timeout**. compression → phase 2 |
| 11 | Middleware binding | Global + by prefix + per route + groups. Chains are **precompiled** on `listen()` |
| 12 | Errors | `try/catch` around `next()`; uncaught → `app.onError` → the default 500; `catch_unwind` at the boundaries; the process never dies |
| 13 | Response contract | `c.json/c.text/c.status/c.header` (primary) plus a returned value as sugar |
| 14 | Request/response bodies | **Streaming** in both directions with backpressure |
| 15 | Stream shape | **Web Streams** (`ReadableStream`/`WritableStream`) plus adapters to Node streams |
| 16 | Graceful shutdown | Rust catches SIGTERM/SIGINT, drains with a deadline, `GOAWAY` for h2, waits for in-flight (JS included), a `shutdown` event plus `await server.close()` |
| 17 | Health / observability | `/healthz` + `/readyz` in Rust (plus a JS readiness callback), `/metrics` in Prometheus format, a JSON log on stdout |
| 18 | Configuration | A single config object; TLS as a path or a Buffer; multi-port (health/metrics separately) |
| 19 | h2c | Prior-knowledge cleartext HTTP/2 (for a mesh or an LB) |
| 20 | Build/delivery | napi-rs CLI, prebuilds on npm, baseline glibc 2.17 plus musl, x64/arm64. Node 18+ (N-API 8) |

## 3. Architecture: the path of a single request

```
   network
    │
    ▼
┌────────────────────── RUST (a tokio thread pool, all cores) ──────────────────────────────┐
│ 1. accept → rustls (TLS + ALPN) → hyper (HTTP/1.1 | HTTP/2 | h2c prior-knowledge)         │
│ 2. matchit: route + params.  No match → 404/405 in Rust (or app.notFound)                  │
│ 3. native middleware at the edges: cors preflight / body-limit / timeout — may short-circuit│
│ 4. the precompiled slot chain for this route leaf                                          │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │ ThreadsafeFunction (one crossing per request)
                                             │ we pass: method, path, params, headers,
                                             │ bodyLimit, a body-stream descriptor
                                             ▼
┌────────────────────── JS (a single event loop, libuv) ────────────────────────────────────┐
│ 5. build c → run the JS middleware onion plus the handler (async)                          │
│    try/catch around everything → app.onError.  Stream backpressure via Web Streams         │
│ 6. resolve(Promise) with a finished c.res: status, headers, body (Buffer | ReadableStream) │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │ JS Promise ↔ Rust Future (awaited without blocking)
                                             ▼
┌────────────────────── RUST ───────────────────────────────────────────────────────────────┐
│ 7. write the response into hyper; for a stream, pull chunks from JS as the socket drains   │
│    "after-next" native middleware (compression — phase 2)                                  │
│ 8. metrics (latency, code, size) — counted in Rust at almost no cost                       │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

The napi-rs primitives: **`ThreadsafeFunction`** (Rust→JS from any tokio thread),
**the JS-`Promise` ↔ Rust-`Future` integration**, and our own **`tokio` runtime** inside the
addon (running alongside the libuv event loop). JS always stays on the libuv thread; all
Rust I/O happens on tokio threads.

## 4. The public JS API (a sketch)

```js
import { Server } from '@oxide-ts/http';

const app = new Server({
  baseUrl: '/api/v1',               // a global prefix for every application route (health/metrics do NOT inherit it)
  customIpHeaders: ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'],  // c.req.ip comes from the first one present
  customCountryHeaders: ['cf-ipcountry', 'x-country-code'],  // c.req.country from the first one present
  tls: { cert: './cert.pem', key: './key.pem' },  // a path or a Buffer/PEM; no tls → plaintext
  http1: true,
  h2c: false,                       // prior-knowledge cleartext h2 on the plaintext port
  bodyLimit: '10mb',
  maxHeaderSize: '16kb',
  requestTimeout: '30s',
  headerReadTimeout: '10s',         // A2: while the headers are being read (Slowloris)
  bodyReadTimeout: '30s',           // A2: while the body is being read
  idleTimeout: '60s',               // A2: idling on a keep-alive connection
  keepAliveTimeout: '75s',
  shutdownTimeout: '30s',           // < the pod's terminationGracePeriodSeconds
  workerThreads: 'auto',            // A3: tokio threads; 'auto' = the pod's cgroup CPU quota, not the node's cores
  proxyProtocol: false,             // A4: PROXY protocol v1/v2 from an L4 LB (AWS NLB) → the real peer IP
  maxConcurrentRequests: 500,       // C5: the in-flight limit; beyond it → 503 + readiness not-ready (see below)
  maxQueue: 0,                      // C5: a queue waiting for a slot (0 = no queue, an immediate 503)
  queueTimeout: '1s',               // C5: how long to wait in the queue before a 503
  socket: { noDelay: true, reusePort: false, backlog: 1024, maxConnections: null },  // B9
  requestId: { header: 'x-request-id', generate: 'uuidv7' },  // B2: generated when missing; placed into c
  http2: {
    enabled: true, maxConcurrentStreams: 250, initialWindowSize: '1mb',
    maxResetStreamsPerSec: 100,     // A1: Rapid Reset protection (CVE-2023-44487)
  },
  health:  { liveness: '/healthz', readiness: '/readyz' },
  metrics: { enabled: true, path: '/metrics', port: 9090 },  // a separate port
  logger:  { format: 'json' },      // B3: c.log carrying the request id
});

// middleware (the onion)
app.use(async (c, next) => {              // global
  const t = performance.now();
  await next();
  c.res.headers.set('x-time', String(performance.now() - t));
});
app.use('/admin/*', authMiddleware);      // by prefix

// routes (plus route middleware)
app.get('/users/:id', validate, (c) => c.json({ id: c.req.params.id }));
app.post('/users', async (c) => {
  const body = await c.req.json();
  return c.json({ created: body }, 201);   // a returned value = sugar over c.json
});

// groups / sub-applications
app.route('/api/v1', apiV1);

// errors and 404
app.onError((err, c) => c.json({ error: err.message }, 500));
app.notFound((c) => c.json({ error: 'not found' }, 404));  // optional, otherwise a 404 from Rust

// the readiness callback (Rust invokes it on /readyz)
app.setReadinessCheck(async () => db.isConnected());

// lifecycle
app.on('shutdown', async () => { await db.close(); });
await app.listen({ port: 3000, host: '0.0.0.0' });
```

## 5. Routing

- The engine is **`matchit` 0.8** (a radix tree). Matching and `params` parsing happen in Rust.
- Supported: static; `:param` (a single segment); a trailing catch-all (`/static/*path`);
  static takes priority over param (automatically).
- **Not** supported: mid-path wildcards, optional parameters, regex constraints, and
  **several parameters in one segment** (`/{id}.{ext}`) — a hard limitation of matchit 0.8
  ("one parameter per segment"). The workaround: match the whole segment (`/:name`) and split
  inside the handler. Optionality → two routes; an `:id` format → validation in the handler.
  <!-- M2: a correction relative to the draft — matchit cannot do multi-param per segment. -->
- The public syntax is Hono-like (`:id`, `*path`); internally it is translated into matchit
  syntax (`{id}`, `{*path}`). The `{id}` form is also accepted as-is.
- Methods: `get/post/put/patch/delete/head/options` plus `all`.
- 404/405 are produced by Rust without waking JS (unless `app.notFound` is set).
- **`baseUrl`** (a global prefix, e.g. `/api/v1`) is glued onto every route **at registration
  time** (while the tree is precompiled, so there is no runtime cost); it composes with group
  prefixes (`baseUrl` + `app.route(prefix)` + the route).
  - `c.req.path` is **without** the prefix (`/users/42`); the full one is available as
    `c.req.url`/`c.req.rawPath` → handlers do not depend on their mount point.
  - **Health/metrics are absolute** and do not inherit the prefix (k8s probes hit `/healthz`
    and friends; they may live on a separate port).
  - Value normalization: a leading slash is required, a trailing one is stripped; empty or
    `'/'` means no prefix.

## 6. Middleware (the onion)

- The Koa/Hono model: `(c, next) => { /* before */ await next(); /* after */ }`.
- The chain is **precompiled on `listen()`**: for every router leaf a final ordered list of
  slots (native Rust plus JS) is built ahead of time; at runtime it is simply executed.
- A slot is either **native (Rust)** or **JS**. Consecutive JS slots are handed to JS in a
  single piece → one boundary crossing per request (not 2×N).
- Native middleware works at the **edges** of the onion (it cannot see `c.set('user')`,
  because the context lives in JS).
- Chain sources: global `app.use(mw)` + prefixed `app.use('/p/*', mw)` + route-level
  `app.get(path, ...mw, handler)` + groups `app.route(prefix, sub)`; the order follows
  registration.

## 6a. The request lifecycle and hooks (Fastify style on top of the onion)

Named lifecycle hooks; every event accepts an **array** of handlers. Some hooks physically
live in Rust — with no JS subscription they run in Rust and the event loop stays asleep.

**The full pipeline of one request (top to bottom):**

```
[ native cors: preflight OPTIONS ]  (Rust, BEFORE onRequest — JS is not woken at all)
onRequest            (JS)    headers parsed, BEFORE routing (early rate-limit/auth)
[ matchit: the route ]       no match → notFound (Rust, or app.notFound in JS)
[ native inbound: cors(origin check) → body-limit → timeout(start the deadline) ]  (Rust)
preParsing           (JS)    before the body is read (the stream can be swapped)
[ read the body honouring bodyLimit + inbound decompression (B5) ]
preValidation        (Rust+JS) A6: Rust checks structure against JSON Schema (off the loop) → 400; then JS valibot finishes transform/refine
preHandler           (JS)    the body is available and valid, before the onion + handler
┌── the middleware ONION: before → HANDLER → after ──┐
└────────────────────────────────────────────────────┘
preSerialization     (JS)    before the result is serialized into bytes
onSend               (JS)    the response is formed, before writing (native outbound: cors headers; compression — phase 2)
[ write to the socket ]      (Rust)
onResponse           (Rust)  processing finished (not necessarily sent successfully); logging/metrics/cleanup
─────────────────────────────────────────────────────────────────
EXCEPTIONS (at any moment):
onError   (JS)   unified: observation plus building the response; no response → 500
onTimeout (Rust) the deadline expired → abort the signal → hooks → c.res or the default 504
onAbort   (Rust) the client went away before the response → abort the signal → hooks → finalization
```

Connection-level hooks (`onConnect` / `onClose`) are deliberately absent: honouring them
means waking JS once per connection, which is exactly what serving connections in Rust
exists to avoid. Per-connection work belongs in a proxy or in metrics.

**Semantics (settled):**
- The handlers of one event run **sequentially** in registration order, each `async`, each
  awaited in turn.
- **Short-circuit:** a hook that formed `c.res` or returned a response stops the pipeline and
  the handler is skipped, but `onSend`/`onResponse` always run.
- A single **`c`** spans the whole lifecycle (`set/get`, `c.req`, `c.res`).
- Any `throw`/reject in any hook goes to the single **`onError`** (which builds the response;
  several handlers run in sequence, the resulting `c.res` goes to the client; no response → 500).
- **"After" hooks** (`onSend`/`onResponse`) **always** run (error, short-circuit, timeout,
  disconnect) — that is the guarantee behind logging/metrics/cleanup. `onResponse` is
  observation only.
- **Scope:** global + group-level (encapsulated, as in Fastify — they do not "leak") + route
  level. Per-stage chains are **precompiled on `listen()`**. Assembly order: global → group →
  route, following registration (with no reversal for the "after" ones).
- **API:** named methods `app.onRequest(fn)`, `app.preHandler(fn)`, … (primary) plus
  `app.addHook(name, fn)` (generic). Route-level ones go through the options:
  `app.get('/x', { onRequest:[...], preHandler:[...] }, handler)`.
- **Rust-level hooks do not wake JS when nobody subscribed**; with a subscription the async
  handler is awaited (and counted as in-flight by graceful shutdown).
- **Native inbound/outbound middleware:** cors — the preflight `OPTIONS` in Rust before
  `onRequest` (JS is not woken) plus an origin check inbound plus `Access-Control-*` headers
  on `onSend`; body-limit — inbound only (`413`); timeout — inbound (starting the deadline) →
  the `onTimeout` branch.

**Cancellation (timeout / disconnect):**
- `c.req.signal` is a standard `AbortSignal`, fired on a timeout **or** a disconnect (pass it
  to `fetch`/a database driver for cooperative cancellation). It fires at most once.
- **Timeout:** abort the signal → `onTimeout` → `c.res` or the default **504**; a late handler
  result is discarded without an error.
- **Disconnect:** abort the signal → `onAbort` → finalization; there is nowhere to send, so
  the result is discarded.
- Flags in `c` for the "after" hooks: `c.res.sent`, `c.aborted` — to tell success from a
  disconnect or a timeout.
- There is exactly one terminal event: `onResponse` **or** `onAbort` **or** the timeout
  branch — they never overlap.

## 6b. Request/response schemas (A6, valibot → JSON Schema → native Rust)

The source of truth is **valibot** (types via `v.InferOutput`); raw JSON Schema is accepted
too. zod/arktype (Standard Schema) through their `toJsonSchema` — phase 2.

```js
import * as v from 'valibot';
const CreateUser = v.object({ name: v.pipe(v.string(), v.minLength(2)), age: v.pipe(v.number(), v.minValue(0)) });

app.post('/users', {
  schema: { body: CreateUser, query: v.object({ ref: v.optional(v.string()) }), response: { 200: UserOut } },
}, (c) => c.json(c.req.valid('body')));   // c.req.valid('body'|'query'|'params') — typed
```

- **On `listen()`**: valibot → JSON Schema (`@valibot/to-json-schema`) → Rust compiles a
  validator (`jsonschema`) and a fast response serializer (the analogue of
  `fast-json-stringify`).
- **Layered validation:** Rust checks structure (types/required/min-max/enum/pattern/format)
  **off the event loop** → `400`; then JS valibot finishes `transform` and custom `check` over
  structurally valid data (the `preValidation` stage).
- **Coercion** of query/params (always strings): Rust converts them according to the schema
  (`?age=42` → a number).
- **Response:** native serialization by the schema plus **stripping of extra fields** (nothing
  outside the schema can leak); response validation happens in **dev** only, in production we
  just serialize.
- **Validation errors:** `400` plus a machine-readable `[{ path, message, code }]`;
  overridable in `onError` or a dedicated hook.

## 6c. Security and networking (A1–A4, B9, B10)

- **A1 HTTP/2 Rapid Reset (CVE-2023-44487):** a reset-stream limit
  (`http2.maxResetStreamsPerSec`), protecting against DoS.
- **A2 Read timeouts** (against Slowloris): `headerReadTimeout`, `bodyReadTimeout`,
  `idleTimeout` — separate from `requestTimeout`.
- **A3 tokio worker threads vs the CPU quota:** `workerThreads: 'auto'` reads the pod's cgroup
  CPU quota (not the node's core count), so we do not overprovision under a ~1 vCPU limit. A
  number can be given explicitly.
- **A4 PROXY protocol v1/v2:** behind an L4 LB (AWS NLB) the real peer IP is taken from the
  PROXY prefix on the socket (socket level). It composes with `customIpHeaders` (first strip
  PROXY, then look at the headers).
- **B9 Socket options:** `TCP_NODELAY` (API latency, on by default), `SO_REUSEPORT`,
  `backlog`, `maxConnections`; listening on a **Unix socket** (`listen({ path })`).
- **B10 HTTP correctness:** auto-`HEAD` (like GET without a body), auto-`OPTIONS`, `405` plus
  an `Allow` header, `431 Request Header Fields Too Large` when `maxHeaderSize` is exceeded,
  `501` for an unknown method.
- **C5 `maxConcurrentRequests` (overload protection plus shedding through k8s):** in-flight is
  counted in Rust. Reality: a plain Service (kube-proxy) cannot hand a request to another pod
  per request — only indirectly. **Two layers:**
  1. **An immediate `503`** past the hard limit (`+ Retry-After`; for h2 a `GOAWAY`, so the
     client reopens against another pod); behind a retry-capable ingress or mesh
     (nginx/Envoy/Istio) the request "moves" without the client seeing an error.
  2. **Readiness → not-ready** under sustained overload → k8s removes the pod from the
     endpoints (new connections go elsewhere). Note: readiness affects **new connections**
     only; an already-open h2 connection keeps sending streams to the same pod, which is why
     layer 1 (`503`/`GOAWAY`) matters more for h2.
  - **A queue** (`maxQueue`, default 0 = none): a brief spike waits for a slot up to
    `queueTimeout`, then gets a `503`.
- **WebSocket is NOT supported** (APIs only); we do not design for upgrades.

## 6d. DX / API additions (group B)

- **B1 Cookies:** `c.req.cookie(name)` (parsing) plus
  `c.cookie(name, val, { httpOnly, secure, sameSite, maxAge, path, domain })`; signed and
  encrypted ones are phase 2 (through separate `Set-Cookie` lines, see the header model section).
- **B2 Request ID:** when there is no `x-request-id` we generate a **UUIDv7**; it goes into
  `c.req.id` and is echoed in the response.
- **B3 The contextual logger `c.log`:** structured JSON with the `requestId` in every record.
- **B4 urlencoded:** `application/x-www-form-urlencoded` → `await c.req.formData()` /
  `c.req.parseBody()`.
- **B5 Inbound decompression:** `Content-Encoding: gzip/br` on the request — unpacked in Rust
  (with `bodyLimit` applied to the decompressed size).
- **B6 Response helpers:** `c.redirect(url, code=302)`, `c.notFound()`, SSE via
  `c.streamSSE(cb)` on top of Web Streams.
- **B7 Server events:** `app.on('listening'|'error'|'close', ...)`; on a failed bind
  (EADDRINUSE) `listen()` rejects with an explicit error.
- **B8 `app.inject(req)`:** a test harness without a real socket (fast integration tests).

## 7. The context `c` (in JS)

- `c.req` — `method`, `path`, `params`, `query`, `headers`, and the body: `c.req.stream`
  (a Web `ReadableStream`), `await c.req.json()` / `.text()` / `.arrayBuffer()` (which buffer
  up to `bodyLimit`).
- `c.req.ip` / `c.req.ips` — the client IP (computed in **Rust**): we walk `customIpHeaders`
  in order and take the first header that is present and non-empty; an `X-Forwarded-For`
  chain (`client, proxy1, ...`) is split on commas — `ip` is the first (leftmost) element,
  trimmed, and `ips` is the whole array. If none is filled in or no list was configured, the
  **TCP socket's peer address** is used (`ip` is always present).
  ⚠️ Trusting forwarded headers is safe **only behind a trusted proxy**; trust-proxy CIDRs are
  phase 2.
- `c.req.country` — the client's country (Rust): the first non-empty one out of
  `customCountryHeaders`, trimmed and uppercased (ISO 3166-1 alpha-2; the Cloudflare special
  values `XX`/`T1` are passed through as-is). No source → `undefined`. Server-side GeoIP by IP
  is phase 2.
- `c.set(k, v)` / `c.get(k)` — sharing data between middleware (pure JS, free).
- `c.res` is mutable: `c.status(n)`, `c.header(k, v)`, `c.res.headers` (editable even "after
  next").
- Response helpers: `c.json(v, status?)`, `c.text(v, status?)`, `c.body(bufferOrStream, status?)`.

## 8. Error handling (a hard invariant: the process never dies)

- Every JS call from the bridge is wrapped: a synchronous `throw` and a rejected Promise both
  become an error for `onError`.
- The JS layer wraps the whole onion in one `try/catch` → any exception reaches
  `app.onError(err, c)`.
- A local `try/catch` around `await next()` in a middleware works naturally (handle it yourself).
- If `app.onError` itself throws → the last line of defence: the default 500 plus a log.
- Rust: `catch_unwind` at every boundary; a panic → 500, and the process stays alive.
- A safety-net process-level `unhandledRejection` handler with an explicit log (it should
  never fire; firing means the wrapper has a bug).

## 9. Streaming (Web Streams, backpressure across the bridge)

- **Request:** `c.req.stream` is a Web `ReadableStream`; `for await (const chunk of ...)`.
  Backpressure: JS signals Rust "ready for more".
- **Response:** `c.body(new ReadableStream(...))` or an async iterable (sugar). Backpressure:
  Rust signals JS "the socket has drained". Use cases: SSE, large downloads/uploads, proxying.
- Compatibility with Node streams goes through `Readable.fromWeb`/`toWeb`.

## 9a. Multipart (`multipart/form-data`, file uploads) — a route option

Enabled **per route**; parsing happens in **Rust** (streaming `multer`), off the event loop.

```js
app.post('/upload', {
  multipart: {                       // true = default limits; an object = overrides
    maxFileSize: '50mb', maxFiles: 10, maxFields: 100, maxFieldSize: '1mb',
    allowedMimeTypes: ['image/*', 'application/pdf'],   // wildcards are supported
    allowedExtensions: ['.png', '.jpg', '.jpeg', '.pdf'],
  }
}, async (c) => {
  for await (const part of c.req.parts()) {            // A: streaming (the primary way)
    if (part.filename) await uploadToS3(part.stream);  // part: { name, filename?, contentType?, stream }
    else fields[part.name] = await part.text();
  }
  // or B (sugar for small forms): const form = await c.req.formData();  // Web FormData, all in memory
});
```

- **A Content-Type that is not `multipart/form-data`** with the flag enabled → `415`.
- **Handing data to JS:** primarily `c.req.parts()` (an async iterator where a file is a Web
  `ReadableStream`, with backpressure across the bridge); the sugar is `c.req.formData()`
  (a Web `FormData`, in memory, protected by `maxFileSize`).
- **Limits (per route, defaults from the global config):** `maxFileSize`→`413`,
  `maxFiles`/`maxFields`→`400`, `maxFieldSize`. Aborted in Rust before reaching JS where
  possible.
- **Type restrictions (applied only to parts with a `filename`):** `allowedMimeTypes` (by the
  part's `Content-Type`, with an `image/*` wildcard) **and** `allowedExtensions` (by
  `filename`); a violation → **`415`**, before the file is read. Both checks happen in Rust.
- **We never touch the disk** (no automatic temp files) — streams and buffers only. A
  `saveTo(path)` helper is phase 2.

## 10. Lifecycle / graceful shutdown (k8s)

1. Rust catches SIGTERM/SIGINT. 2. It closes the listener (no new connections).
3. Readiness → "not ready" (k8s steers traffic away). 4. It waits for in-flight requests
(JS handlers included), h2 gets a `GOAWAY`. 5. The `shutdownTimeout` deadline
(< `terminationGracePeriodSeconds`) → the remainder is forcibly torn down.
6. The `shutdown` event fires in JS (close the DB pool and so on), `await server.close()`.
7. Exit with code 0.
- Optional: JS can intercept the signal itself.

## 11. Health / observability

- `/healthz` (liveness) — Rust answers instantly, JS is not woken.
- `/readyz` (readiness) — Rust; it accounts for shutdown and the optional
  `app.setReadinessCheck()` (which asks JS).
- `/metrics` — Prometheus from Rust: RPS, latencies (histograms), status codes,
  connections/streams, sizes. Can be turned off.
- A structured JSON log on stdout.
- Health/metrics can be moved to a **separate port** (so they are not exposed publicly).
- Optional (phase 2): propagating `traceparent` (W3C Trace Context).

## 12. TLS and protocols

- **rustls**; certificates as a file path or a Buffer/PEM string.
- The TLS port: ALPN negotiates **h2** / **http/1.1**.
- The plaintext port: **http/1.1** and/or **h2c prior-knowledge** (per config flags). The h2c
  upgrade dance is not supported.
- Phase 2: certificate hot-reload (cert-manager / Let's Encrypt rotation).

## 13. Building and delivery

- Tooling: **`@napi-rs/cli`** (cross-compilation, `.d.ts`, platform packages, prebuild
  publishing).
- **N-API 8** (Node 18+): one binary for every Node version (ABI-stable).
- The addon's libc must match Node's libc → we publish several variants and the loader picks
  one via `detect-libc` plus `optionalDependencies`.
- The glibc variants are built in the **napi-rs docker images** against the **glibc 2.17**
  baseline (manylinux2014) → they work on **Ubuntu / UBI 8/9/10 / Debian / Amazon Linux / RHEL**.

The matrix (priority ↓):

| Triple | Coverage | Priority |
|---|---|---|
| `x86_64-unknown-linux-gnu` (baseline 2.17) | Ubuntu, **UBI 9/10**, Debian, Amazon Linux — x64 | 1 |
| `aarch64-unknown-linux-gnu` (baseline) | the same on ARM64 / Graviton | 1 |
| `x86_64-unknown-linux-musl` | Alpine x64 | 2 |
| `aarch64-unknown-linux-musl` | Alpine ARM64 | 2 |
| `aarch64-apple-darwin` | local development (M-series Macs) | dev |
| `x86_64-apple-darwin` | Intel Macs | optional |
| `x86_64-pc-windows-msvc` | Windows development | optional |

- Delivery: prebuilds on npm (the main `@oxide-ts/http` plus `@oxide-ts/http-linux-x64-gnu`
  and friends in `optionalDependencies`). A Docker image needs no Rust toolchain — `npm ci`
  pulls a ready binary.

## 14. The proposed project layout

```
http-rust/
├── Cargo.toml               # a cdylib crate, napi-rs
├── package.json             # the napi config, targets, optionalDependencies
├── build.rs
├── src/                     # Rust
│   ├── lib.rs               # the napi exports, RustServer
│   ├── server.rs            # tokio + hyper + rustls, listen/accept
│   ├── router.rs            # matchit, chain precompilation
│   ├── bridge.rs            # ThreadsafeFunction, Promise↔Future, stream backpressure
│   ├── middleware/          # native: body_limit, cors, timeout
│   ├── stream.rs            # the Web Streams ↔ hyper body bridge
│   ├── tls.rs               # the rustls config, ALPN
│   ├── health.rs            # /healthz, /readyz
│   ├── metrics.rs           # Prometheus
│   └── shutdown.rs          # signals, drain, GOAWAY
├── js/                      # the JS wrapper
│   ├── index.js / index.d.ts
│   ├── context.js           # c, c.req, c.res
│   ├── onion.js             # onion composition
│   └── streams.js           # Web Streams adapters
├── __test__/                # integration tests (JS)
├── examples/
└── DESIGN.md
```

## 15. Phasing

**v1 (MVP):**
- The Rust↔JS bridge (ThreadsafeFunction, Promise↔Future).
- tokio + hyper + rustls; HTTP/1.1, HTTP/2 (ALPN), h2c prior-knowledge.
- matchit routing; methods; `baseUrl`; 404/405 in Rust; `app.notFound`/`app.onError`.
- The precompiled middleware onion; global/prefix/route/group scopes.
- **Lifecycle hooks** (Fastify style): `onRequest`…`onResponse`,
  `onError/onTimeout/onAbort`; `AbortSignal`.
- The context in JS; `c.json/text/body/status/header`; a returned value as sugar;
  `c.req.ip/ips/country/id`; `c.log`.
- Request/response streaming through Web Streams with backpressure; multipart (per route,
  `parts()`).
- **Schemas (A6):** valibot → JSON Schema → native validation and serialization in Rust;
  layered; `preValidation`.
- Native middleware: body-limit, cors, timeout.
- **Security/networking (A1–A4):** the Rapid Reset limit, read timeouts,
  `workerThreads:auto` (cgroup), PROXY protocol; socket options; HEAD/OPTIONS/405/431;
  `maxConcurrentRequests` (503/GOAWAY + readiness shedding + a queue).
- **DX (B):** cookies, request id (UUIDv7), urlencoded, inbound decompression,
  `redirect/notFound/streamSSE`, server events, `app.inject()`.
- Graceful shutdown; `/healthz`, `/readyz` plus the readiness callback; `/metrics`; a JSON
  log; multi-port.
- The napi-rs build: linux gnu x64/arm64 (baseline) + musl + darwin-arm64; prebuilds on npm.

**Phase 2 (as the need arises):**
- Native **compression** (gzip/brotli, streaming).
- A **worker_threads** pool (only if profiling shows CPU-bound JS — not expected).
- TLS certificate hot-reload; trust-proxy CIDRs; server-side GeoIP by IP.
- zod/arktype (Standard Schema) through `toJsonSchema`; signed and encrypted cookies;
  `saveTo()` for multipart; an extended `allowedExtensions`.
- W3C Trace Context / OpenTelemetry.
- Extra platform targets (darwin-x64, windows).
- **Not planned:** WebSocket, static files, Range/trailers, HTML rendering.

## 17. Testing and benchmarks

- **Rust unit tests** (`cargo test`): the router, chain precompilation, the parsers (query,
  units, headers), native middleware.
- **JS integration tests** (a server on a random port, `undici`/`fetch`): routes,
  params/query, onion order, `onError`, 404/405, streaming (request/response, SSE), TLS+ALPN
  (h1/h2), h2c, graceful shutdown, health/metrics. On every LTS Node.
- **Bridge/leaks:** run N requests while watching RSS/heap; a Rust panic must not kill the
  process; `unhandledRejection` must never fire.
- **Benchmarks:** `h2load` (h2), `bombardier`/`oha` (h1) — RPS, p50/p99; compared against
  `node:http`, Fastify and Hono-on-Node; streaming/SSE measured separately.
- **CI** (GitHub Actions): the build matrix (linux gnu/musl x64/arm64, darwin) plus
  `cargo test` plus the JS tests on Node 18/20/22/24; prebuild publishing on a tag.

## 16. Open questions (all closed)

- ~~The npm package name / scope~~ → `@oxide-ts/http`, the class `Server`.
- ~~Query-string parsing~~ → in **Rust** ahead of time; `c.req.query` = last-wins strings;
  `c.req.queries('k')` → an array of every value.
- ~~Header representation~~ → lowercase everywhere; `c.req.header(name)` plus `c.res.headers`
  (`set`/`append`); `Set-Cookie` as separate lines; h2 pseudo-headers are hidden.
- ~~The unit format in the config~~ → we accept **both a string and a number** (`'10mb'`/`'30s'`
  or bytes/ms), typed `string | number`.
- ~~The testing/benchmarking strategy~~ → see §17.
- ~~baseUrl, customIpHeaders, customCountryHeaders, multipart~~ → added (§4, §9a).
- ~~The completeness audit (A1–A6, B1–B10, WebSocket, schemas)~~ → decided: A1–A4 + A6 + all
  of B in v1; WebSocket is not supported; schemas go valibot → JSON Schema → Rust.
