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
Run: `--duration=8 --connections=64`.

| Server | RPS | p50 | p99 |
|---|---:|---:|---:|
| `node:http` | 68,905 | 0.89 ms | 1.78 ms |
| `@oxide-ts/http`, native endpoint (no JS) | 67,869 | 0.89 ms | 1.84 ms |
| `@oxide-ts/http`, JS handler | 39,896 | 1.40 ms | 4.14 ms |

The same run with `--connections=192`:

| Server | RPS | p50 | p99 |
|---|---:|---:|---:|
| `node:http` | 65,477 | 2.89 ms | 3.56 ms |
| `@oxide-ts/http`, native endpoint | 64,606 | 2.92 ms | 3.75 ms |
| `@oxide-ts/http`, JS handler | 40,069 | 4.23 ms | 11.59 ms |

`fastify` and `hono` were not part of this run — they are not installed in the measurement
environment.

## What follows from this

**1. The Rust path is limited by the client, not by itself.** The native endpoint and
`node:http` produce identical results and **do not grow** when connections go from 64 to
192 (they even dip slightly). That is saturated-client behaviour. The real ceiling of the
Rust path is not visible here — an external generator is needed.

**2. The dominant cost is crossing into JS.** The difference between the native endpoint
and a JS handler on the same server: 67.9k → 39.9k RPS, i.e. **≈10.6 µs per request**
(25.1 µs versus 14.5 µs). That is the TSFN call, the `Promise` across the boundary,
building the context `c` and running the onion.

**3. The project's original hypothesis does not hold for routes with a JS handler.**
`@oxide-ts/http` with a JS handler is slower than `node:http` (39.9k versus 68.9k). The win
today exists only where JS never wakes at all: routing, `404`/`405`, CORS preflight, a
schema rejection, probes, `413`/`415` — all of which are answered from Rust and run at the
speed of the native endpoint.

This is not a verdict on the architecture, but it is not what the architecture was built
for either. Before claiming a speed advantage, those 10 µs need to be broken down.

## Profiling the boundary crossing

A layer-by-layer breakdown — [bench/profile.mjs](bench/profile.mjs) plus
[bench/profile-servers.mjs](bench/profile-servers.mjs). Each layer adds exactly one thing
to the previous one; `ELU` is the event loop utilization of the server process under load.

| Layer | RPS | µs/request | ELU | Δ vs previous |
|---|---:|---:|---:|---:|
| `native` — JS never wakes | 66,774 | 14.98 | **0.000** | — |
| `bridge` — TSFN + `Promise`, callback returns a constant | 57,403 | 17.42 | **0.976** | +2.44 µs |
| `touch` — same plus reading **all** fields of the napi object | 58,052 | 17.23 | ~0.98 | −0.19 µs |
| `ctx` — plus `buildContext` and `buildNativeResponse` | 45,369 | 22.04 | **1.000** | +4.81 µs |
| `full` — plus the middleware onion and hooks | 42,048 | 23.78 | **1.000** | +1.74 µs |

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

**3. The expensive part is our own JS layer.** `buildContext` plus `buildNativeResponse`
add 4.81 µs and the onion another 1.74 µs: **6.55 µs** together, roughly 27% of main-thread
time per request. That is the addressable headroom.

A curious detail: in an isolated micro-benchmark (a tight loop over the same input object)
`buildContext` + `c.json` + `buildNativeResponse` fit into **0.86 µs** — more than five
times less than on the real path. The difference is the price of allocating ~25 closures,
several `Map`s and a large object literal per request, all of which live across a promise
boundary instead of dying inside a tight loop. V8's young-generation size
(`--max-semi-space-size=64`) does not change the result — this is not GC pressure as such.

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
- **Reduce allocations in `buildContext`** — the only genuinely addressable headroom
  (~6.5 µs out of 23.8). Directions: move context methods onto a prototype instead of ~25
  closures per request; build `query`, headers, `_store` and the logger lazily. The ceiling
  of this work is returning to ~17.4 µs, which is still slower than `node:http`.
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
