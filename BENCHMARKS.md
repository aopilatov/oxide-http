# `@oxide-ts/http` benchmarks

Measurements are produced by the harness in [bench/run.mjs](bench/run.mjs):

```bash
node bench/run.mjs --duration=10 --connections=64
# full comparison (participants join in if installed):
npm i -D fastify hono @hono/node-server && node bench/run.mjs
```

## Methodology

- Every server runs in a **separate process** ([bench/servers.mjs](bench/servers.mjs)).
  This matters: when the server and the load generator share a process, the JS handler
  competes with the client for the event loop and a native server ends up at a clear
  disadvantage. The first version of the harness had exactly that flaw — the numbers
  differed by almost a factor of two.
- The client is `node:http` with a keep-alive agent, no external dependencies.
- 2s warm-up, then measurement; RPS, p50 and p99 are reported.
- The `/json` scenario: the route returns a small JSON object.

### A limitation worth keeping in mind

The load generator is Node as well, and against fast servers **it becomes the bottleneck
itself**. That is visible directly below: the native endpoint and `node:http` hit the same
ceiling and do not grow when the connection count increases. For those two the measurement
therefore shows the client's ceiling, not the server's.

Authoritative numbers require an external generator from a separate machine:

```bash
oha -z 30s -c 64 http://<host>:<port>/json          # HTTP/1.1
bombardier -d 30s -c 64 http://<host>:<port>/json
h2load -n 200000 -c 64 -m 32 https://<host>:<port>/json   # HTTP/2
```

## Results

Hardware: Apple M-series, 16 cores, macOS (darwin-arm64), Node v24.16.0.
Run: `--duration=8 --connections=64`, after the prototype-context rewrite (see below).

| Server | RPS | p50 | p99 |
|---|---:|---:|---:|
| `node:http` | 71,622 | 0.87 ms | 1.74 ms |
| `@oxide-ts/http`, native endpoint (no JS) | 76,192 | 0.79 ms | 1.71 ms |
| `@oxide-ts/http`, JS handler | 60,657 | 0.88 ms | 3.2 ms |

The same run with `--connections=192`:

| Server | RPS | p50 | p99 |
|---|---:|---:|---:|
| `node:http` | 67,245 | 2.83 ms | 3.27 ms |
| `@oxide-ts/http`, native endpoint | 69,413 | 2.74 ms | 3.25 ms |
| `@oxide-ts/http`, JS handler | 59,974 | 2.85 ms | 16.29 ms |

Before the rewrite the JS-handler row was 39,896 RPS (p50 1.40 ms, p99 4.14 ms) at 64
connections — the wrapper rework bought **+52%** on JS routes and closed the gap to
`node:http` from −42% to −15%.

`fastify` and `hono` were not part of this run — they are not installed in the measurement
environment.

## What follows from this

**1. The Rust path is limited by the client, not by itself.** The native endpoint and
`node:http` produce identical results and **do not grow** when connections go from 64 to
192 (they even dip slightly). That is saturated-client behaviour. The real ceiling of the
Rust path is not visible here — an external generator is needed.

**2. The dominant cost is crossing into JS.** After the prototype-context rewrite the
difference between the native endpoint and a JS handler on the same server is
76.2k → 60.7k RPS, i.e. **≈3.4 µs per request** (16.5 µs versus 13.1 µs) — down from
≈10.6 µs before it. What remains is essentially the TSFN call and the `Promise` across
the boundary; the wrapper itself is now nearly free (see the profile below).

**3. JS-handler routes still do not beat `node:http`, and will not.** With a JS handler
`@oxide-ts/http` reaches 60.7k versus 71.6k for `node:http` (−15%; before the rewrite it
was −42%). The remaining gap is the boundary round trip itself — the floor measured by
the `bridge` layer (~16.9 µs) sits above `node:http`'s entire request (~14 µs). The win
exists where JS never wakes at all: routing, `404`/`405`, CORS preflight, a schema
rejection, probes, `413`/`415` — all answered from Rust at native-endpoint speed.

## Profiling the boundary crossing

A layer-by-layer breakdown — [bench/profile.mjs](bench/profile.mjs) plus
[bench/profile-servers.mjs](bench/profile-servers.mjs). Each layer adds exactly one thing
to the previous one; `ELU` is the event loop utilization of the server process under load.

Before the prototype-context rewrite:

| Layer | RPS | µs/request | ELU | Δ vs previous |
|---|---:|---:|---:|---:|
| `native` — JS never wakes | 66,774 | 14.98 | **0.000** | — |
| `bridge` — TSFN + `Promise`, callback returns a constant | 57,403 | 17.42 | **0.976** | +2.44 µs |
| `touch` — same plus reading **all** fields of the napi object | 58,052 | 17.23 | ~0.98 | −0.19 µs |
| `ctx` — plus `buildContext` and `buildNativeResponse` | 45,369 | 22.04 | **1.000** | +4.81 µs |
| `full` — plus the middleware onion and hooks | 42,048 | 23.78 | **1.000** | +1.74 µs |

After it (context methods on a prototype, lazy derived views, no per-request
options/`AbortController`/logger/store allocations, onion skipped for bare routes):

| Layer | RPS | µs/request | Δ vs `bridge` |
|---|---:|---:|---:|
| `native` | 69,855–71,135 | ~14.2 | — |
| `bridge` | 59,107–60,032 | ~16.8 | — |
| `ctx` | 53,682–53,888 | ~18.6 | +1.8 µs |
| `full` — the whole public path | 57,249–57,760 | ~17.4 | **+0.6 µs** |

`full` now sits within ~0.6 µs of the bare-bridge floor: the entire wrapper (context,
onion, hooks, dispatch) costs less than a microsecond per request. `ctx` reads *slower*
than `full` only because that harness variant allocates a fresh options literal per
request and calls the standalone `buildContext`, while the public server passes
per-leaf options precompiled at `listen()` — the anomaly measures the harness, not the
library.

### What this means

**1. Any route with a JS handler is bound by a single thread.** As soon as JS is involved,
ELU reaches ~1.0 — even for a minimal callback that just returns a prepared constant. No
matter how many tokio workers exist, the throughput of such routes is limited by
main-thread time. The native path shows ELU = 0.000: JS is not involved there at all, and
the ceiling is set by the measurement client rather than the server.

**2. Reading data across the boundary is free.** The `touch` variant reads *every* field of
`MatchedRequest` — headers, query, params, ip, ips, id — and costs the same as the variant
that touches none of them (17.23 versus 17.40 µs, within noise). That rules out the
hypothesis of expensive napi object access: the boundary data shape does not need redesign.

**3. The expensive part was our own JS layer — and it has been reclaimed.** Before the
rewrite `buildContext` plus `buildNativeResponse` added 4.81 µs and the onion another
1.74 µs: **6.55 µs** together, roughly 27% of main-thread time per request. The cause was
allocating ~25 closures, several `Map`s and a large object literal per request, all
living across a promise boundary (an isolated micro-benchmark of the same work fit into
0.86 µs). The rewrite moved context methods onto class prototypes, made every derived
view lazy (header map, query records, cookies, logger, store, `ResHeaders`,
`AbortController`), precompiled per-leaf context options at `listen()` and skips the
onion for routes without middleware — after which the whole wrapper costs **~0.6 µs**.

**4. Strategic conclusion: optimizing the wrapper will not make JS routes faster than
`node:http`.** The round trip across the boundary alone is 17.4 µs of main-thread time, and
that is the floor. `node:http` handles an entire request in ~14.5 µs. Even a zero-cost
wrapper would leave us slower on JS routes.

The architecture wins where JS never wakes: routing, `404`/`405`, `Allow`, CORS preflight,
schema rejection, probes, `413`/`415`/`431`, limits and timeouts. On a route that ends up in
a JS handler anyway there is no speed advantage and there will not be one — the advantages
there are different (validation and limits before the event loop wakes, backpressure,
graceful shutdown, metrics without JS).

## What to measure and fix next

- ✅ **The boundary-crossing profile has been taken** — see the section above. Conclusion:
  data access across the boundary is free; the expensive parts are our JS layer (6.55 µs)
  and the round trip itself (17.4 µs).
- ✅ **Reduce allocations in `buildContext`** — done: prototype-based context, lazy derived
  views, per-leaf options precompiled at `listen()`, onion fast-path. The full path landed
  at ~17.4 µs (≈0.6 µs over the bare bridge), i.e. the predicted ceiling was reached; the
  JS-handler scenario went 39.9k → 60.7k RPS. Further gains require attacking the round
  trip itself or sharding JS across worker threads.
- **Verify with an external generator** — to establish the real ceiling of the Rust path and
  how much headroom actually exists.
- **Add scenarios:** streaming/SSE, multipart uploads, a route with a schema (where Rust-side
  validation should pay off), and HTTP/2 through `h2load`.
- **Compare against `fastify` and `hono`** — install them and run.

## Survivability tests

Separately from speed, the suite contains stability checks
([__test__/stability.test.ts](__test__/stability.test.ts)):

- memory under load plateaus instead of growing linearly (measured in blocks in a child
  process with `--expose-gc`; RSS: +98 / +7 / +5 / +2 / +0.1 MB per 20k-request block —
  the growth decays while `heapUsed` stays at ~8 MB);
- 3000 consecutive requests with a `throw` in the handler → 3000 `500` responses, process
  alive;
- under mixed load (`ok`/`throw`/`reject`/body) `unhandledRejection` never fires;
- client-aborted requests do not accumulate resources;
- 30 `listen`/`close` cycles leave no ports or handles behind.

The server's baseline RSS is about 190 MB on a 16-core machine: tokio worker stacks (the
count comes from the cgroup quota, see §6c A3) plus hyper buffers and the V8 heap. In a
container with `limits.cpu: 1` there will be fewer workers and correspondingly less
baseline memory.
