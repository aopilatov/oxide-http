# Fix plan — second audit pass, 2026-07-20

Findings from re-reading the code after the first audit landed (stages A–D, commits
`fixes a` … `fixes d`). That round's tracker is in git history at `4313623` if the
rationale behind an earlier decision is ever needed.

One of these is a regression the first pass introduced — E1 — and it is the only item
that breaks working user code.

**Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done

**Progress:** 8 / 8 items · both stages complete

| Stage | Theme | Items | Done |
| --- | --- | --- | --- |
| E | Correctness — includes a regression | 3 | 3 |
| F | Accuracy of metrics, checks and docs | 5 | 5 |

Final verification: `cargo clippy -- -D warnings` clean, 38 Rust unit tests pass, 155 JS
tests pass (run twice), `npm run typecheck` clean.

E1 was checked against a standalone reproduction; E2, E3, F1 and F2 were each run against
the un-fixed code and fail without their fix.

---

## Stage E — Correctness — **done 2026-07-20**

### [x] E1 — Concurrent cold `inject()` throws "already listening" — **regression from C3**

`inject()` auto-starts the server with `if (!this.#listening) await this.listen(...)`
(`js/index.ts:686`). With no schemas anywhere `listen()` runs to completion synchronously
and nothing can interleave. Add a schema and it hits `await loadSchemaDeps()`, which is a
suspension point: two cold `inject()` calls both pass the `!#listening` test, both call
`listen()`, and the second one now hits the C3 guard and throws.

Reproduced: `Promise.all([app.inject(…), app.inject(…)])` on a server with one schema'd
route prints `listen: this server is already listening`.

Before C3 the second `listen()` silently overwrote the running server — worse in
principle, but it did not throw, so `Promise.all` over injects used to work. Running two
injects concurrently is ordinary test code, so this is a real break.

- Give the auto-start path its own memoised promise (`#autostart`) so concurrent cold
  callers await the same `listen()` instead of each starting one.
- Clear it when the promise settles, so a retry after a failed start still works.
- Leave the public `listen()` guard alone: an explicit double `listen()` must still throw.
- Test: `Promise.all` of two cold injects on a schema'd server.

Done as planned, via `#ensureListening()`. Note what is *not* covered: two concurrent
explicit `listen()` calls still race the same way and one will throw — that is correct
behaviour (the guard is the point), and only the implicit auto-start needed coalescing.

### [x] E2 — An explicit `bodyLimit: undefined` disables the limit

The D1 check is `'bodyLimit' in config && config.bodyLimit == null`, and `== null` is true
for `undefined` as well as `null`. Spreading a config object that carries an explicit
`bodyLimit: undefined` therefore turns the limit off instead of applying the 10mb default —
and with the limit off there is no bound on decompressed size either, so zip-bomb
protection goes with it.

- Narrow the test to `=== null`. `undefined` then falls through to the `?? '10mb'` default.
- TypeScript with `exactOptionalPropertyTypes` already rejects this shape, so the exposure
  is callers from plain JS.

Done. The `'bodyLimit' in config` test also became redundant once the comparison is strict,
so the condition is now a plain `config.bodyLimit === null`.

### [x] E3 — A retry after a failed bind duplicates the valibot hook

`injectValidation(route)` mutates `route.hooks` in place, and `listen()` calls it over
every route each time. A failed bind (`EADDRINUSE`) leaves `#listening` false and the
native state empty, so retrying on another port is a legitimate pattern — and that retry
prepends a second copy of the synthetic preValidation hook.

Harmless in effect (validation simply runs twice) but it compounds per retry.

- Mark the route once injected and skip it on later passes.

Done via a `validationInjected` flag on the route entry. The test pins it by counting how
many times a valibot `transform` runs after a first `listen()` fails with EADDRINUSE — a
duplicated hook shows up as two transform calls for one request.

---

## Stage F — Accuracy of metrics, checks and docs — **done 2026-07-20**

### [x] F1 — `http_request_body_bytes_total` misses bodies buffered for schemas

`read_body_task` counts bytes via `add_request_bytes`; `buffer_body` (`src/server.rs:1170`)
does not. Any route with a body schema is therefore absent from the counter — and B1 widened
that path to cover compressed bodies too, so the share of untracked traffic grew.

- Count bytes in `buffer_body` as well. Count the bytes actually read off the socket, not
  the decompressed size, so the counter keeps meaning "bytes received".

Done as planned.

### [x] F2 — The probe-collision check only catches exact string matches

A6 compares route patterns to probe paths as strings (`src/lib.rs:415`), so `app.get('/:page')`
passes the check and is then silently shadowed by `/healthz` at runtime — exactly the trap
the check exists to prevent.

- Run the enabled probe paths through the built router instead of comparing strings, so a
  parametric or wildcard route that would swallow a probe path is caught too.

Done. Only GET/HEAD are checked, since `admin_response` returns `None` for anything else —
so a `POST /healthz` route is legitimate and still works, and the test pins that.

### [x] F3 — `c.req.stream` yields different bytes depending on whether a schema exists

On a schema'd route Rust buffers and decodes the body, so the stream delivers plain bytes;
without a schema the same request delivers the raw compressed bytes, with an identical
`content-encoding` header either way. Two routes handed the same request see different
"raw" payloads.

- Decide and document: the pragmatic reading is that `c.req.stream` is a decoded stream and
  `content-encoding` describes what the client sent. Worth stating explicitly in the README
  rather than leaving it to be discovered.

**Fixed rather than documented, and the plan above had it backwards.** `c.req.stream` never
decoded anything — it hands over channel bytes as-is — so the honest rule is the opposite
one: the stream carries exactly what the client sent, and `text()`/`json()`/`arrayBuffer()`
decode. I started writing the planned wording into the README, checked it against the code,
and found it was false.

Making that rule true everywhere meant keeping the raw body for the channel and the decoded
copy for validation only, instead of sending JS the decoded copy. `Bytes` is refcounted, so
the uncompressed case shares one buffer; only a genuinely compressed body holds two, each
already bounded by `bodyLimit`.

Bonus: the `body_decoded` flag added in B1 is gone from the bridge, `MatchedRequest` and
`context.ts` — the asymmetry it existed to paper over no longer exists.

### [x] F4 — Access-log drop reporting has two tails

The "dropped N lines" notice is emitted only after the *next* successfully written line, so
if traffic stops right after a burst the loss is never reported. Separately, lines still
queued when the process exits are lost — the writer thread is not drained on shutdown.

Both are inherent to moving the log off the request path; the point is to record them rather
than have someone rediscover them while debugging a missing log line.

- Document in the README alongside `accessLog`, and note the queue depth.

Done, including the advice to log from the handler when no line may be lost.

### [x] F5 — The admin port keeps its own connection counter

The stage-A note claimed admin connections are counted "against `max_connections`"; they are
actually counted against a *separate* pool of the same size, so the process can hold up to
2 × `maxConnections`. The separate pool is the better behaviour — load on the main port must
not starve the probes — but the description was wrong.

- Fix the wording in the README and note the doubling explicitly.

Done: documented as per-listener, with the reason the pools are separate.
