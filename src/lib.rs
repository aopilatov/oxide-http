#![deny(clippy::all)]

//! `@oxide-ts/http` — the native addon (napi-rs). The public JS API lives in the
//! `js/index.ts` wrapper; this file holds the low-level `RustServer`.
//! See DESIGN.md.

mod bridge;
mod compress;
mod cors;
mod cpu;
mod health;
mod idle;
mod listener;
mod metrics;
mod multipart;
mod overload;
mod proxy_protocol;
mod router;
mod schema;
mod server;
mod stream;
mod tls;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::{Function, Promise};
use napi::Result;
use napi_derive::napi;
use tokio::runtime::Runtime;
use tokio::sync::{watch, Notify};

use bytes::Bytes;

use crate::bridge::{Handler, JsResponse, MatchedRequest};
use crate::cors::{Cors, CorsOptions as RCorsOptions};
use crate::listener::Bound;
use crate::router::{RouteDef as RRouteDef, Routes};
use crate::server::{serve, Shared, Tuning};
use crate::stream::BodyIo;

/// CORS options from the JS side (normalized by the wrapper). Absent = CORS off.
#[napi(object)]
pub struct CorsOptions {
    pub origins: Vec<String>,
    pub methods: Vec<String>,
    pub allowed_headers: Option<Vec<String>>,
    pub exposed_headers: Option<Vec<String>>,
    pub credentials: bool,
    pub max_age: Option<i64>,
}

/// Route definition from the JS wrapper (path already joined with baseUrl/group prefix).
/// Schemas are JSON Schema strings (the wrapper converts valibot beforehand).
#[napi(object)]
pub struct RouteDef {
    pub method: String,
    pub path: String,
    pub leaf_id: i32,
    pub body_schema: Option<String>,
    pub query_schema: Option<String>,
    pub params_schema: Option<String>,
    pub multipart: Option<MultipartOptions>,
}

/// Per-route multipart options (normalized by the wrapper; limits in bytes/counts).
#[napi(object)]
pub struct MultipartOptions {
    pub max_file_size: Option<i64>,
    pub max_field_size: Option<i64>,
    pub max_files: Option<i64>,
    pub max_fields: Option<i64>,
    pub allowed_mime_types: Option<Vec<String>>,
    pub allowed_extensions: Option<Vec<String>>,
}

/// TLS certificates (PEM strings; the wrapper resolves path/Buffer).
#[napi(object)]
pub struct TlsOptions {
    pub cert: String,
    pub key: String,
}

/// HTTP/2 options (§6c A1).
#[napi(object)]
pub struct Http2Options {
    pub max_concurrent_streams: Option<i64>,
    pub initial_window_size: Option<i64>,
    pub max_reset_streams_per_sec: Option<i64>,
}

/// Server options that affect how the context is computed in Rust (§4, §7, §6d).
#[napi(object)]
pub struct ListenOptions {
    pub custom_ip_headers: Option<Vec<String>>,
    pub custom_country_headers: Option<Vec<String>>,
    pub request_id_header: Option<String>,
    /// Hard request body limit in bytes (authoritative in Rust). null/absent = no limit.
    pub body_limit: Option<i64>,
    /// Native CORS. null/absent = disabled.
    pub cors: Option<CorsOptions>,
    /// TLS (§12). null/absent = plaintext.
    pub tls: Option<TlsOptions>,
    /// h2c prior-knowledge on the plaintext port (§19).
    ///
    /// `js_name` is required: napi's auto-conversion yields `h2C` (the letter after a
    /// digit is upper-cased) while the wrapper sends `h2c` — the field was silently lost.
    #[napi(js_name = "h2c")]
    pub h2c: Option<bool>,
    /// Header read timeout in ms (Slowloris, §6c A2).
    pub header_read_timeout: Option<i64>,
    /// Timeout waiting for a request body chunk, ms (§6c A2) → 408.
    pub body_read_timeout: Option<i64>,
    /// Connection idle without reads/writes, ms (§6c A2) → close.
    pub idle_timeout: Option<i64>,
    /// TLS handshake timeout in ms.
    pub handshake_timeout: Option<i64>,
    /// Limit on the number of headers.
    pub max_headers: Option<i64>,
    /// Header block size limit in bytes (§6c B10) → 431.
    pub max_header_size: Option<i64>,
    /// Graceful shutdown deadline in ms (§10). Defaults to 10s.
    pub shutdown_timeout: Option<i64>,
    /// Pause between dropping readiness and closing the listener, ms (§10 + §11).
    /// Gives the balancer time to remove the pod from endpoints before refusals start.
    pub pre_shutdown_delay: Option<i64>,
    /// Unix socket path (§6c B9). Set → we listen on it and ignore `port`/`host`.
    pub unix_path: Option<String>,
    /// Accept queue depth (§6c B9). Defaults to 1024.
    pub backlog: Option<i64>,
    /// `SO_REUSEPORT` — several processes on one port (§6c B9).
    pub reuse_port: Option<bool>,
    /// `TCP_NODELAY` (§6c B9). Enabled by default.
    pub no_delay: Option<bool>,
    /// Cap on concurrent connections (§6c B9).
    pub max_connections: Option<i64>,
    /// Expect PROXY protocol v1/v2 on every connection (§6c A4).
    pub proxy_protocol: Option<bool>,
    /// Number of tokio workers; `0`/absent = auto from the cgroup quota (§6c A3).
    pub worker_threads: Option<i64>,
    /// Liveness probe path (§11). Empty string disables it.
    pub health_path: Option<String>,
    /// Readiness probe path (§11). Empty string disables it.
    pub ready_path: Option<String>,
    /// Prometheus metrics path (§11). Empty string disables it.
    pub metrics_path: Option<String>,
    /// Separate port for probes/metrics (§11); set → they are absent from the main port.
    pub admin_port: Option<u16>,
    /// JSON access log to stdout (§11).
    pub access_log: Option<bool>,
    /// Cap on concurrently handled requests (§6c C5). Above it — 503.
    pub max_concurrent_requests: Option<i64>,
    /// How many requests may wait for a slot beyond the limit (§6c C5). 0 = no queue.
    pub max_queue: Option<i64>,
    /// How long to wait in the queue, ms (§6c C5). Defaults to 1s.
    pub queue_timeout: Option<i64>,
    /// `Retry-After` header value in seconds for 503 (§6c C5).
    pub retry_after: Option<i64>,
    /// How long continuous overload must last before readiness drops, ms (§6c C5).
    /// Absent/0 = leave readiness alone.
    pub overload_shed_after: Option<i64>,
    pub http2: Option<Http2Options>,
}

/// `app.inject` response (§17): no socket involved, same shape as a regular response.
#[napi(object)]
pub struct InjectResponse {
    pub status: u16,
    pub headers: Vec<bridge::KvPair>,
    pub body: napi::bindgen_prelude::Buffer,
}

// Default protective timeouts (§6c A2). Leaving these off meant a client could trickle a
// body forever and keep-alive connections were never reclaimed.
const DEFAULT_HEADER_READ_TIMEOUT_MS: i64 = 30_000;
const DEFAULT_BODY_READ_TIMEOUT_MS: i64 = 30_000;
/// Above the usual ALB/nginx keep-alive (60s) so the upstream closes first — closing
/// under it makes the balancer race us into a half-closed connection.
const DEFAULT_IDLE_TIMEOUT_MS: i64 = 75_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS: i64 = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS: i64 = 10_000;
const DEFAULT_QUEUE_TIMEOUT_MS: i64 = 1_000;

/// A protective timeout in ms: unset falls back to `default_ms`, `0` disables it, and a
/// negative value is a config error. Silently dropping a negative used to turn a typo
/// (`-5000`) into "protection off".
fn timeout_ms(name: &str, v: Option<i64>, default_ms: i64) -> Result<Option<Duration>> {
    match v.unwrap_or(default_ms) {
        0 => Ok(None),
        n if n > 0 => Ok(Some(Duration::from_millis(n as u64))),
        n => Err(napi::Error::from_reason(format!(
            "{name}: must be >= 0 (0 disables it), got {n}"
        ))),
    }
}

/// A literal delay or deadline in ms, where `0` genuinely means zero (no wait) rather
/// than "disabled".
fn delay_ms(name: &str, v: Option<i64>, default_ms: i64) -> Result<Duration> {
    match v.unwrap_or(default_ms) {
        n if n >= 0 => Ok(Duration::from_millis(n as u64)),
        n => Err(napi::Error::from_reason(format!(
            "{name}: must be >= 0, got {n}"
        ))),
    }
}

/// A bound socket before handing it to the runtime (reactor registration happens there).
enum ListenTarget {
    Tcp(std::net::TcpListener),
    Unix(std::os::unix::net::UnixListener),
}

/// State of a running server (lives while the server listens).
struct Running {
    runtime: Runtime,
    /// Broadcast of the stop signal: both the accept loop and every connection listen
    /// to it (`watch`, not `Notify`: we must wake everyone, including late subscribers).
    shutdown: watch::Sender<u8>,
    /// "Drain complete" signal from the accept loop.
    done: Arc<Notify>,
    /// Shared state — needed so JS can change readiness on the fly (§11).
    shared: Arc<Shared>,
    /// Drain deadline plus slack: a safety net if the `done` signal never arrives.
    close_deadline: std::time::Duration,
    /// Pause between dropping readiness and closing the listener (§10 + §11).
    pre_shutdown_delay: std::time::Duration,
}

/// The low-level server. Wrapped by the JS `Server` class.
#[napi]
pub struct RustServer {
    state: Mutex<Option<Running>>,
}

#[napi]
impl RustServer {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)] // the constructor is exported to JS
    pub fn new() -> Self {
        RustServer {
            state: Mutex::new(None),
        }
    }

    /// Start HTTP/1.1 on `host:port` with a route table.
    ///
    /// Routing/`404`/`405`/auto-`OPTIONS` happen in Rust; hitting a leaf calls
    /// `dispatch(req) => Promise<res>`. Non-blocking (the accept loop runs in background).
    #[napi]
    pub fn listen(
        &self,
        port: u16,
        host: String,
        routes: Vec<RouteDef>,
        has_not_found: bool,
        options: ListenOptions,
        dispatch: Function<(MatchedRequest, BodyIo), Promise<JsResponse>>,
    ) -> Result<()> {
        // Overwriting a running server used to drop the previous `Running` silently: that
        // destroys a tokio Runtime on Node's event-loop thread and cuts the first server's
        // connections with no graceful drain.
        if self.state.lock().unwrap().is_some() {
            return Err(napi::Error::from_reason(
                "listen: this server is already listening; call close() first",
            ));
        }

        // Compile trees and schemas BEFORE bind: conflicts/invalid patterns/schemas fail early.
        let n = routes.len();
        let mut route_defs = Vec::with_capacity(n);
        let mut schema_slots: Vec<Option<crate::schema::LeafSchema>> =
            (0..n).map(|_| None).collect();
        let mut mp_slots: Vec<Option<crate::multipart::MultipartConfig>> =
            (0..n).map(|_| None).collect();
        for r in routes {
            // A multipart body is a stream of parts, not one JSON document, so a body
            // schema there can never match — every request would 400. Say so at startup.
            if r.multipart.is_some() && r.body_schema.is_some() {
                return Err(napi::Error::from_reason(format!(
                    "route {} {}: schema.body is not supported on a multipart route — \
                     validate the parsed parts inside the handler",
                    r.method, r.path
                )));
            }
            let leaf = crate::schema::LeafSchema::build(crate::schema::SchemaDef {
                body: r.body_schema,
                query: r.query_schema,
                params: r.params_schema,
            })
            .map_err(napi::Error::from_reason)?;
            let idx = r.leaf_id as usize;
            if idx < n {
                schema_slots[idx] = Some(leaf);
                mp_slots[idx] = r.multipart.map(multipart_config);
            }
            route_defs.push(RRouteDef {
                method: r.method,
                path: r.path,
                leaf_id: r.leaf_id,
            });
        }
        let schemas: Vec<crate::schema::LeafSchema> = schema_slots
            .into_iter()
            .map(Option::unwrap_or_default)
            .collect();
        // Kept for the health-path collision check below: `tuning` (which resolves those
        // paths) is built after `route_defs` has been consumed by the router.
        let route_paths: Vec<(String, String)> = route_defs
            .iter()
            .map(|r| (r.method.clone(), r.path.clone()))
            .collect();
        let routes = Routes::build(route_defs).map_err(napi::Error::from_reason)?;

        // Build the TSFN synchronously while the JS function is alive; afterwards it is
        // 'static + Send.
        let tsfn: Handler = dispatch.build_threadsafe_function().build()?;

        // TLS acceptor (PEM parsing may fail → an early error before bind).
        let tls = match options.tls {
            Some(t) => {
                Some(tls::build_acceptor(&t.cert, &t.key).map_err(napi::Error::from_reason)?)
            }
            None => None,
        };
        let http2 = options.http2;
        let shutdown_timeout = delay_ms(
            "shutdownTimeout",
            options.shutdown_timeout,
            DEFAULT_SHUTDOWN_TIMEOUT_MS,
        )?;
        let default_sock = crate::listener::SocketOptions::default();
        let socket = crate::listener::SocketOptions {
            backlog: options
                .backlog
                .filter(|&n| n > 0)
                .map(|n| n as i32)
                .unwrap_or(default_sock.backlog),
            reuse_port: options.reuse_port.unwrap_or(default_sock.reuse_port),
            nodelay: options.no_delay.unwrap_or(default_sock.nodelay),
        };
        let tuning = Tuning {
            tls,
            shutdown_timeout,
            max_connections: options
                .max_connections
                .filter(|&n| n > 0)
                .map(|n| n as usize),
            proxy_protocol: options.proxy_protocol.unwrap_or(false),
            health_paths: {
                let d = crate::health::HealthPaths::default();
                // Metrics stay off the main port unless asked for: /metrics is an
                // information-disclosure surface and DESIGN §11 keeps it internal. With a
                // dedicated admin port there is no public exposure, so default it on.
                let metrics_default = if options.admin_port.is_some() {
                    d.metrics
                } else {
                    String::new()
                };
                crate::health::HealthPaths {
                    health: options.health_path.unwrap_or(d.health),
                    ready: options.ready_path.unwrap_or(d.ready),
                    metrics: options.metrics_path.unwrap_or(metrics_default),
                }
            },
            admin_port: options.admin_port,
            access_log: options.access_log.unwrap_or(false),
            h2c: options.h2c.unwrap_or(false),
            header_read_timeout: timeout_ms(
                "headerReadTimeout",
                options.header_read_timeout,
                DEFAULT_HEADER_READ_TIMEOUT_MS,
            )?,
            body_read_timeout: timeout_ms(
                "bodyReadTimeout",
                options.body_read_timeout,
                DEFAULT_BODY_READ_TIMEOUT_MS,
            )?,
            idle_timeout: timeout_ms(
                "idleTimeout",
                options.idle_timeout,
                DEFAULT_IDLE_TIMEOUT_MS,
            )?,
            handshake_timeout: timeout_ms(
                "handshakeTimeout",
                options.handshake_timeout,
                DEFAULT_HANDSHAKE_TIMEOUT_MS,
            )?,
            max_headers: options.max_headers.filter(|&n| n > 0).map(|n| n as usize),
            max_header_size: options
                .max_header_size
                .filter(|&n| n > 0)
                .map(|n| n as usize),
            max_concurrent_streams: http2
                .as_ref()
                .and_then(|h| h.max_concurrent_streams)
                .filter(|&n| n >= 0)
                .map(|n| n as u32),
            initial_window_size: http2
                .as_ref()
                .and_then(|h| h.initial_window_size)
                .filter(|&n| n >= 0)
                .map(|n| n as u32),
            max_reset_streams: http2
                .as_ref()
                .and_then(|h| h.max_reset_streams_per_sec)
                .filter(|&n| n >= 0)
                .map(|n| n as usize),
            socket,
        };

        // Probes and metrics are answered in Rust before routing, so a user route sharing
        // one of those paths would silently never run. Only the main port is affected —
        // with an admin port the endpoints live on a different socket entirely.
        //
        // Matched through the router rather than by comparing pattern strings: `/:page`
        // never equals "/healthz" as text but swallows it at runtime, which is exactly the
        // trap this check exists to catch.
        if tuning.admin_port.is_none() {
            let p = &tuning.health_paths;
            let endpoints = [
                ("health", &p.health),
                ("readiness", &p.ready),
                ("metrics", &p.metrics),
            ];
            for (name, endpoint) in endpoints {
                if endpoint.is_empty() {
                    continue;
                }
                // Probes only answer GET/HEAD, so a POST on the same path is fine.
                let hit = routes
                    .match_route("GET", endpoint)
                    .or_else(|| routes.match_route("HEAD", endpoint));
                if let Some(m) = hit {
                    let which = usize::try_from(m.leaf_id)
                        .ok()
                        .and_then(|i| route_paths.get(i))
                        .map(|(method, path)| format!("route {method} {path}"))
                        .unwrap_or_else(|| "a route".to_string());
                    return Err(napi::Error::from_reason(format!(
                        "{which} collides with the {name} endpoint ({endpoint}): the probe \
                         is answered before routing, so the route would never run. Rename \
                         the route, disable the endpoint with an empty path, or move probes \
                         to a separate port via health.port"
                    )));
                }
            }
        }

        // Bind synchronously → errors (EADDRINUSE, no permission for the path) surface
        // immediately. A Unix socket takes priority over port/host when a path is set.
        let unix_path = options.unix_path.clone();
        let listen_target: ListenTarget = match &unix_path {
            Some(path) => ListenTarget::Unix(
                listener::bind_unix(path)
                    .map_err(|e| napi::Error::from_reason(format!("bind unix {path}: {e}")))?,
            ),
            None => ListenTarget::Tcp(
                listener::bind_tcp(&host, port, &tuning.socket)
                    .map_err(|e| napi::Error::from_reason(format!("bind {host}:{port}: {e}")))?,
            ),
        };

        // The admin port (§11) is bound synchronously too: a busy metrics port must fail
        // listen() instead of surfacing later as silently missing probes.
        let admin_target = match tuning.admin_port {
            Some(p) => Some(
                listener::bind_tcp(&host, p, &tuning.socket)
                    .map_err(|e| napi::Error::from_reason(format!("bind admin {host}:{p}: {e}")))?,
            ),
            None => None,
        };

        // Workers: an explicit number, otherwise auto from the cgroup quota (§6c A3) —
        // inside a container the node's core count far exceeds the pod's real limit.
        let workers = match options.worker_threads.filter(|&n| n > 0) {
            Some(n) => n as usize,
            None => crate::cpu::worker_threads_auto(),
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(workers)
            .enable_all()
            .build()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;

        let max_concurrent = options
            .max_concurrent_requests
            .filter(|&n| n > 0)
            .map(|n| n as usize);
        // Computed up front: the `overload` field below builds them inside a closure,
        // where `?` is unavailable.
        let queue_timeout = delay_ms(
            "queueTimeout",
            options.queue_timeout,
            DEFAULT_QUEUE_TIMEOUT_MS,
        )?;
        let overload_shed_after = timeout_ms("overloadShedAfter", options.overload_shed_after, 0)?;

        let shared = Arc::new(Shared {
            tsfn,
            routes,
            has_not_found,
            custom_ip_headers: options.custom_ip_headers.unwrap_or_default(),
            custom_country_headers: options.custom_country_headers.unwrap_or_default(),
            request_id_header: options
                .request_id_header
                .unwrap_or_else(|| "x-request-id".to_string()),
            body_limit: options.body_limit.filter(|&n| n >= 0).map(|n| n as u64),
            cors: options.cors.map(|o| {
                Cors::new(RCorsOptions {
                    origins: o.origins,
                    methods: o.methods,
                    allowed_headers: o.allowed_headers,
                    exposed_headers: o.exposed_headers,
                    credentials: o.credentials,
                    max_age: o.max_age,
                })
            }),
            schemas,
            multipart: mp_slots,
            tuning,
            metrics: Arc::new(crate::metrics::Metrics::new()),
            readiness: crate::health::Readiness::default(),
            overload: max_concurrent.map(|limit| {
                crate::overload::Limiter::new(
                    limit,
                    options.max_queue.filter(|&n| n > 0).unwrap_or(0) as usize,
                    queue_timeout,
                    options.retry_after.filter(|&n| n > 0).unwrap_or(1) as u64,
                    overload_shed_after,
                )
            }),
        });
        let pre_shutdown_delay = delay_ms("preShutdownDelay", options.pre_shutdown_delay, 0)?;
        let (shutdown, shutdown_rx) = watch::channel(crate::server::RUNNING);
        let done = Arc::new(Notify::new());
        let done_srv = done.clone();

        // Readiness is also driven from JS (setReady/setReadinessCheck).
        let readiness_handle = shared.clone();

        if let Some(admin) = admin_target {
            let admin_shared = shared.clone();
            let admin_shutdown = shutdown.subscribe();
            runtime.spawn(async move {
                if let Ok(l) = tokio::net::TcpListener::from_std(admin) {
                    crate::server::serve_admin(l, admin_shared, admin_shutdown).await;
                }
            });
        }
        // Registering the socket with the reactor happens inside the runtime (from_std needs it).
        runtime.spawn(async move {
            let bound = match listen_target {
                ListenTarget::Tcp(l) => tokio::net::TcpListener::from_std(l).map(Bound::Tcp),
                ListenTarget::Unix(l) => tokio::net::UnixListener::from_std(l).map(Bound::Unix),
            };
            let Ok(bound) = bound else {
                done_srv.notify_one();
                return;
            };
            serve(bound, shared, shutdown_rx, done_srv).await;
        });

        *self.state.lock().unwrap() = Some(Running {
            runtime,
            shutdown,
            done,
            shared: readiness_handle,
            close_deadline: shutdown_timeout + std::time::Duration::from_secs(1),
            pre_shutdown_delay,
        });
        Ok(())
    }

    /// Run a request through the pipeline without a socket (§17, `app.inject`).
    ///
    /// Executes on the server runtime (where the TSFN and state live); the result comes
    /// back through a oneshot. Requires a started server: routes and schemas are compiled
    /// in `listen()` — the wrapper starts one on an ephemeral port when needed, but the
    /// request itself never travels over a socket.
    #[napi]
    pub async fn inject(
        &self,
        method: String,
        path: String,
        headers: Vec<bridge::KvPair>,
        body: Option<napi::bindgen_prelude::Buffer>,
    ) -> Result<InjectResponse> {
        let (shared, handle) = {
            let guard = self.state.lock().unwrap();
            let running = guard
                .as_ref()
                .ok_or_else(|| napi::Error::from_reason("inject: server is not running"))?;
            (running.shared.clone(), running.runtime.handle().clone())
        };

        let body_bytes = body.map(|b| Bytes::from(b.to_vec())).unwrap_or_default();
        let mut builder = hyper::Request::builder().method(method.as_str()).uri(&path);
        let mut has_host = false;
        for kv in &headers {
            if kv.key.eq_ignore_ascii_case("host") {
                has_host = true;
            }
            builder = builder.header(&kv.key, &kv.value);
        }
        if !has_host {
            // HTTP/1.1 requires Host; inject has no real host — use a placeholder.
            builder = builder.header("host", "inject.local");
        }
        let req = builder
            .body(http_body_util::Full::new(body_bytes))
            .map_err(|e| napi::Error::from_reason(format!("inject: malformed request: {e}")))?;

        let (tx, rx) = tokio::sync::oneshot::channel();
        handle.spawn(async move {
            let _ = tx.send(crate::server::inject(shared, req).await);
        });

        match rx.await {
            Ok(Ok((status, headers, body))) => Ok(InjectResponse {
                status,
                headers,
                body: body.to_vec().into(),
            }),
            Ok(Err(e)) => Err(napi::Error::from_reason(e)),
            Err(_) => Err(napi::Error::from_reason("inject: task aborted")),
        }
    }

    /// Set readiness from JS (§11): `app.setReady(false)` removes the pod from the
    /// endpoints without touching liveness. The periodic `readinessCheck` pushes its
    /// verdict here too. Before `listen()` this is a no-op (there is no state yet).
    #[napi]
    pub fn set_ready(&self, ready: bool) -> Result<()> {
        if let Some(running) = self.state.lock().unwrap().as_ref() {
            running.shared.readiness.set_js_ready(ready);
        }
        Ok(())
    }

    /// Graceful shutdown (§10). Resolves once in-flight requests have finished (or
    /// `shutdownTimeout` expired). Idempotent: a repeated call is a no-op.
    ///
    /// Order: signal → the accept loop closes the listener (the port frees immediately)
    /// → connections receive `graceful_shutdown` (h2 gets `GOAWAY`) → drain → `done`.
    ///
    /// The runtime is shut down on a separate OS thread via `shutdown_timeout` rather
    /// than `shutdown_background`: the latter returns immediately and **may never destroy
    /// the runtime at all** (tokio docs). Then `Arc<Shared>` is never dropped, and with it
    /// the listener (port stays busy) and the `ThreadsafeFunction` (holds a ref on the
    /// event loop) stay alive — the Node process never exits.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        let Some(running) = self.state.lock().unwrap().take() else {
            return Ok(());
        };
        // Stage 1: drop readiness but keep accepting. The balancer needs time to notice
        // the `/readyz` 503 and drain traffic away; closing the listener right away would
        // give connection refused to requests already routed to this pod.
        running.shared.readiness.set_draining(true);
        if !running.pre_shutdown_delay.is_zero() {
            let _ = running.shutdown.send(crate::server::PRE_SHUTDOWN);
            tokio::time::sleep(running.pre_shutdown_delay).await;
        }

        // Stage 2: stop accepting and ask connections to close.
        // The send error is ignored: there may be no receivers left (accept loop died).
        let _ = running.shutdown.send(crate::server::CLOSING);

        // Wait for the drain. Our own deadline covers the case where the `done` signal
        // never arrives (a panic in the accept loop): close() must not hang forever.
        let _ = tokio::time::timeout(running.close_deadline, running.done.notified()).await;

        std::thread::spawn(move || {
            running
                .runtime
                .shutdown_timeout(std::time::Duration::from_secs(1));
        });
        Ok(())
    }
}

/// napi MultipartOptions → the internal MultipartConfig (limits i64 → u64/u32).
fn multipart_config(o: MultipartOptions) -> crate::multipart::MultipartConfig {
    let u64_of = |v: Option<i64>| v.filter(|&n| n >= 0).map(|n| n as u64);
    let u32_of = |v: Option<i64>| v.filter(|&n| n >= 0).map(|n| n as u32);
    crate::multipart::MultipartConfig {
        max_file_size: u64_of(o.max_file_size),
        max_field_size: u64_of(o.max_field_size),
        max_files: u32_of(o.max_files),
        max_fields: u32_of(o.max_fields),
        allowed_mime: o
            .allowed_mime_types
            .map(|v| v.iter().map(|s| s.to_lowercase()).collect()),
        allowed_ext: o
            .allowed_extensions
            .map(|v| v.iter().map(|s| s.to_lowercase()).collect()),
    }
}
