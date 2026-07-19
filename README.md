# `@oxide-ts/http`

An HTTP/1.1 and HTTP/2 server for Node.js: the network layer, routing, validation and
limits live in Rust (hyper + tokio), while application handlers stay in JS/TypeScript.

```ts
import { Server } from '@oxide-ts/http';

const app = new Server();

app.get('/users/:id', (c) => c.json({ id: c.req.params.id }));
app.post('/echo', async (c) => c.json(await c.req.json()));

await app.listen({ port: 3000 });
```

---

## An honest word about performance

Let's start with what usually goes unmentioned.

**On routes that end up in a JS handler this library is slower than the built-in
`node:http`** — roughly 40k versus 69k RPS in our measurements. The reason is
architectural: every such request crosses the napi boundary (a ThreadsafeFunction call
plus a `Promise` across the boundary), and that crossing alone costs ~17 µs of main-thread
time, while `node:http` handles an entire request in ~14.5 µs. Optimizing the JS wrapper
will not close that gap — the floor is known and measured.

**The win is where JS never wakes at all.** Everything below is answered from Rust without
taking a single microsecond from the event loop (ELU = 0.000 versus 1.0 on JS routes):

| What | Effect |
|---|---|
| Routing, `404`, `405` + `Allow`, auto-`HEAD`/`OPTIONS` | never reaches JS |
| CORS preflight | answered by Rust |
| Schema validation rejection → `400` | JS stays asleep |
| `413` (body limit), `415` (type), `431` (headers), `408` (read timeout) | cut off at the edge |
| `503` on overload + `Retry-After` | before a slot is taken |
| `/healthz`, `/readyz`, `/metrics` | answer under load and during drain |

So the point is not "faster than Node" but that **junk and housekeeping traffic never
reaches your event loop**, while production plumbing (graceful shutdown, backpressure,
metrics, limits) comes built in and runs outside JS.

Detailed numbers and methodology live in [BENCHMARKS.md](BENCHMARKS.md).

---

## Installation

```bash
npm i @oxide-ts/http
# schemas are optional:
npm i valibot @valibot/to-json-schema
```

Node 18+. Prebuilt binaries: linux x64/arm64 (glibc and musl), macOS arm64/x64.
No Rust toolchain is needed to install.

---

## The context `c`

The single argument of a handler.

```ts
app.post('/orders/:id', async (c) => {
  c.req.method;                  // 'POST'
  c.req.path;                    // '/orders/42' (without baseUrl)
  c.req.params.id;               // '42'
  c.req.query.sort;              // last-wins
  c.req.queries('tag');          // every value
  c.req.header('content-type');  // case-insensitive
  c.req.ip;                      // honours customIpHeaders and PROXY protocol
  c.req.id;                      // UUIDv7 when no x-request-id arrived
  c.req.cookie('sid');
  c.req.signal;                  // AbortSignal: timeout/disconnect

  await c.req.json();            // body (the limit is enforced in Rust)
  await c.req.text();
  await c.req.arrayBuffer();
  await c.req.formData();
  c.req.stream;                  // ReadableStream with backpressure
  c.req.parts();                 // multipart, streaming

  c.set('user', user);           // sharing between middleware
  c.get('user');
  c.log.info('message', { extra: 1 });  // JSON log carrying requestId

  c.status(201).header('x-a', 'b');
  c.cookie('sid', 'v', { httpOnly: true, sameSite: 'lax' });
  return c.json({ ok: true });   // or c.text / c.body / c.redirect / c.notFound
});
```

A returned value works as sugar: an object → `c.json`, a string → `c.text`,
a Buffer/stream → `c.body`.

## Routes and groups

```ts
app.get(path, handler);
app.get(path, options, handler);          // schemas, multipart, route hooks
app.get(path, mw1, mw2, handler);         // route middleware
// post / put / patch / delete / head / options / all — same shape

const api = new Server();
api.get('/ping', (c) => c.text('pong'));
app.route('/api/v1', api);                // mounting under a prefix
```

⚠️ One parameter per segment: `/:id` works, `/{id}.{ext}` does not (a router limitation).
Work around it by matching the whole segment and splitting inside the handler.

## Middleware and hooks

```ts
app.use(async (c, next) => { await next(); });      // global
app.use('/admin', authMiddleware);                  // scoped by prefix

app.onRequest(fn);        // before the body is parsed
app.preValidation(fn);
app.preHandler(fn);
app.preSerialization(fn); // the "after" hooks always run
app.onSend(fn);           // the last place to adjust headers
app.onResponse(fn);       // observation
app.onTimeout(fn);
app.onError((err, c) => c.json({ error: String(err) }, 500));
```

Order: `onRequest → preParsing → preValidation → preHandler → [middleware → handler] →
preSerialization → onSend → onResponse`. Any "before" hook that produces a response stops
the chain; the "after" hooks always run.

## Schemas

```ts
import * as v from 'valibot';

app.post('/users', {
  schema: {
    body: v.object({ name: v.string(), age: v.number() }),
    query: v.object({ dryRun: v.boolean() }),
    response: { 200: v.object({ id: v.string() }) },   // extra fields are stripped
  },
}, (c) => c.json({ id: 'u1', secret: 'will-not-leak' }));
```

The structural part is checked in Rust — an invalid request receives a `400` without waking
JS. valibot then applies `transform`/`check` in JS. Query and params are coerced by the
schema types (`?age=42` arrives as a number). Raw JSON Schema is accepted too.

Error shape: `{ error: 'validation', issues: [{ in, path, message, code }] }`.

## Testing without a socket

```ts
const res = await app.inject({ method: 'POST', path: '/users', body: { name: 'Anna' } });
res.status;      // 400
res.json();
res.headers['content-type'];
res.rawHeaders;  // with duplicates (multiple set-cookie)
```

The request travels through an in-memory pipe and **the same** pipeline — routing, schemas,
CORS, metrics, the onion. This is not a mock.

---

## Configuration

```ts
new Server({ /* ... */ });
```

**Basics:** `baseUrl`, `bodyLimit` (`'10mb'`), `requestTimeout` (`'30s'`),
`requestId.header`, `customIpHeaders`, `customCountryHeaders`.

**Protocol:** `tls: { cert, key }` (a PEM string, a path or a Buffer; ALPN negotiates
h2/http1.1 automatically), `h2c: true` (HTTP/2 prior-knowledge on the plaintext port),
`http2: { maxConcurrentStreams, initialWindowSize, maxResetStreamsPerSec }`.

**Timeouts and limits:** `headerReadTimeout`, `bodyReadTimeout` (→`408`),
`idleTimeout`, `handshakeTimeout`, `maxHeaders`, `maxHeaderSize` (→`431`).

**Lifecycle:** `shutdownTimeout` (default `'10s'`), `preShutdownDelay`,
`handleSignals` (SIGTERM/SIGINT are handled by default).

**Network:** `backlog`, `reusePort`, `noDelay`, `maxConnections`, `proxyProtocol`,
`workerThreads: number | 'auto'` (auto reads the pod's cgroup quota, not the node's cores).

**Observability:** `health: { path, readyPath, metricsPath, port }`, `accessLog`.

**Overload:** `maxConcurrentRequests`, `maxQueue`, `queueTimeout`, `retryAfter`,
`overloadShedAfter`.

**CORS:** `cors: { origin, methods, allowedHeaders, exposedHeaders, credentials, maxAge }`.
Preflight is answered by Rust. Dynamic origin logic goes into a regular JS middleware.

Units accept both a string (`'10mb'`, `'30s'`) and a number (bytes, milliseconds).

---

## Production: k8s

```ts
const app = new Server({
  preShutdownDelay: '10s',   // drop readiness and keep accepting while the LB drains
  shutdownTimeout: '15s',    // drain deadline
  health: { port: 9090 },    // probes and metrics on a separate port
  maxConcurrentRequests: 500,
  overloadShedAfter: '5s',
  workerThreads: 'auto',
});

app.setReadinessCheck(async () => db.isConnected(), { interval: 2000 });
```

A manifest lives in [examples/k8s.yaml](examples/k8s.yaml). The key part:
`terminationGracePeriodSeconds` must be **greater** than `preShutdownDelay + shutdownTimeout`,
otherwise k8s kills the pod mid-drain.

Shutdown sequence: SIGTERM → `/readyz` returns `503` (the pod leaves the endpoints), the
listener **keeps accepting** for `preShutdownDelay` → then accepting stops, h2 receives
`GOAWAY`, in-flight requests finish until `shutdownTimeout` → `exit 0`.

## Metrics

`/metrics` in Prometheus format: `http_requests_total{method,status}` (status is a class:
`2xx`/`4xx`/...), the `http_request_duration_seconds` histogram,
`http_requests_in_flight`, `http_connections_active`, and body byte counters.

---

## Examples

| File | Topic |
|---|---|
| [01-basic.ts](examples/01-basic.ts) | routes, params, query, cookies |
| [02-schemas.ts](examples/02-schemas.ts) | validation, coercion, response stripping |
| [03-streaming.ts](examples/03-streaming.ts) | SSE, large responses, streaming the request body |
| [04-multipart.ts](examples/04-multipart.ts) | file uploads with limits |
| [05-middleware.ts](examples/05-middleware.ts) | the onion, hooks, errors, groups |
| [06-tls-h2.ts](examples/06-tls-h2.ts) | TLS, ALPN, h2c |
| [k8s.yaml](examples/k8s.yaml) | a manifest with probes and graceful shutdown |

## What is not here

- **WebSocket** — not supported and not planned (this library is about APIs).
- **Several parameters in one path segment** — a router limitation.
- **A dynamic origin function in the native CORS** — write a JS middleware.
- **TLS certificate hot-reload** — phase two.
- **The exact status code in metrics** — only the class (cardinality).

## Development

```bash
npm run build        # build the native addon (requires Rust)
npm test             # 128 tests, .ts executed by Node directly
npm run typecheck    # tsc for the library and the tests
npm run lint         # clippy + typecheck
node bench/run.mjs   # benchmarks
```

The JS layer's sources are TypeScript in `js/*.ts` (the `src/` directory holds the Rust
code), built into `dist/` (CJS). Architecture and the decisions behind it live in
[DESIGN.md](DESIGN.md).

## License

MIT

---

## Building from source

The prebuilt binaries cover linux x64/arm64 (glibc and musl) and macOS arm64/x64.
If your platform is not on that list, build it yourself — Rust is required:

```bash
git clone https://github.com/aopilatov/oxide-http && cd oxide-http
npm ci
npm run build:release   # .node for the current platform
npm run build:ts        # dist/ (CJS + types)
node scripts/smoke.cjs  # verify the addon loads
```

The bundled Dockerfiles verify loading inside a clean image:

```bash
docker build -f examples/docker/Dockerfile.ubi9 .     # glibc binary
docker build -f examples/docker/Dockerfile.alpine .   # musl binary
```

Important: the addon's libc must match Node's libc. Alpine needs the musl binary
specifically — a glibc build will not load there.
