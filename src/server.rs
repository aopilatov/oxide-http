//! tokio + hyper: the accept loop and request handling (HTTP/1.1).
//!
//! Edges live in Rust (§6a): CORS preflight and body-limit cut requests off before JS
//! wakes up. The request body is read into a channel (backpressure JS→Rust); the
//! response body can stream through a channel-backed `Body` (backpressure Rust→JS).
//! See stream.rs / cors.rs.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
use hyper_util::server::graceful::GracefulConnection;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::sync::{watch, Notify};
use tokio_rustls::TlsAcceptor;

use crate::bridge::{Handler, JsResponse, KvPair, MatchedRequest};
use crate::cors::Cors;
use crate::health::{HealthPaths, Readiness};
use crate::idle::{watch_idle, Activity, ActivityIo};
use crate::listener::{Bound, SocketOptions};
use crate::metrics::Metrics;
use crate::overload::{Limiter, Slot};
use crate::proxy_protocol;
use crate::router::Routes;
use crate::stream::{AbortSignal, BodyIo, BodyMsg, ChannelBody, BODY_CHANNEL_CAP};

/// Protocol/security parameters (TLS, h2, read timeouts) — §12, §6c A1/A2.
pub struct Tuning {
    pub tls: Option<TlsAcceptor>,
    pub h2c: bool,
    pub header_read_timeout: Option<Duration>,
    /// Timeout waiting for the next request body chunk (§6c A2) → 408.
    pub body_read_timeout: Option<Duration>,
    /// Connection idle without reads/writes (§6c A2). Covers h1 keep-alive too.
    pub idle_timeout: Option<Duration>,
    /// Drain deadline during graceful shutdown (§10); once it expires we cut the rest.
    pub shutdown_timeout: Duration,
    /// Socket options (§6c B9); the accept loop only needs `nodelay` from them.
    pub socket: SocketOptions,
    /// Cap on concurrent connections (§6c B9). None = no limit.
    pub max_connections: Option<usize>,
    /// Expect a PROXY prefix on every connection (§6c A4).
    pub proxy_protocol: bool,
    /// Probe and metrics paths (§11); an empty string disables the endpoint.
    pub health_paths: HealthPaths,
    /// Separate port for probes/metrics (§11). Some → they are absent from the main port.
    pub admin_port: Option<u16>,
    /// Print the access log to stdout as a JSON line (§11).
    pub access_log: bool,
    /// TLS handshake deadline; also bounds the PROXY prefix read (§6c A4), which happens
    /// before TLS and before the idle watchdog exists. None = no deadline.
    pub handshake_timeout: Option<Duration>,
    pub max_headers: Option<usize>,
    /// Header block size limit; exceeding it → 431 (§6c B10).
    pub max_header_size: Option<usize>,
    pub max_concurrent_streams: Option<u32>,
    pub initial_window_size: Option<u32>,
    pub max_reset_streams: Option<usize>,
}

/// hyper's lower bound for the read buffer: anything smaller panics inside `max_buf_size`.
const MIN_HEADER_BUF: usize = 8192;

/// Apply a deadline when one is configured, otherwise just await. `None` = timed out.
async fn maybe_timeout<F: std::future::Future>(d: Option<Duration>, fut: F) -> Option<F::Output> {
    match d {
        Some(d) => tokio::time::timeout(d, fut).await.ok(),
        None => Some(fut.await),
    }
}

/// Unified response body type: a buffer (`Full`) or a stream (`ChannelBody`).
type ResBody = BoxBody<Bytes, Infallible>;

/// Shared state common to all connections.
pub struct Shared {
    pub tsfn: Handler,
    pub routes: Routes,
    pub has_not_found: bool,
    pub custom_ip_headers: Vec<String>,
    pub custom_country_headers: Vec<String>,
    pub request_id_header: String,
    /// Hard request body limit in bytes (authoritative, in Rust). None = no limit.
    pub body_limit: Option<u64>,
    /// Native CORS (the onion's edge). None = disabled.
    pub cors: Option<Cors>,
    /// Compiled schemas by leaf_id (validation off the event loop). Empty = no schemas.
    pub schemas: Vec<crate::schema::LeafSchema>,
    /// Multipart configs by leaf_id. None = the route is not multipart.
    pub multipart: Vec<Option<crate::multipart::MultipartConfig>>,
    /// Protocol/TLS/timeouts.
    pub tuning: Tuning,
    /// Prometheus counters (§11). Arc because body-reading tasks need a 'static clone.
    pub metrics: Arc<Metrics>,
    /// Readiness state (§11): shutdown/overload/flag from JS.
    pub readiness: Readiness,
    /// Concurrent request limiter (§6c C5). None = no limit.
    pub overload: Option<Limiter>,
}

/// Auto builder (h1 + h2 via ALPN/preface) with timeout and h2 settings.
fn build_auto(t: &Tuning) -> auto::Builder<TokioExecutor> {
    let mut b = auto::Builder::new(TokioExecutor::new());
    {
        let mut h1 = b.http1();
        h1.timer(TokioTimer::new());
        if let Some(to) = t.header_read_timeout {
            h1.header_read_timeout(to);
        }
        if let Some(m) = t.max_headers {
            h1.max_headers(m);
        }
        if let Some(sz) = t.max_header_size {
            h1.max_buf_size(sz.max(MIN_HEADER_BUF));
        }
    }
    {
        let mut h2 = b.http2();
        h2.timer(TokioTimer::new());
        if let Some(sz) = t.max_header_size {
            h2.max_header_list_size(sz as u32);
        }
        if let Some(m) = t.max_concurrent_streams {
            h2.max_concurrent_streams(m);
        }
        if let Some(w) = t.initial_window_size {
            h2.initial_stream_window_size(w);
        }
        if let Some(r) = t.max_reset_streams {
            h2.max_pending_accept_reset_streams(r); // A1: Rapid Reset (CVE-2023-44487)
        }
    }
    b
}

/// http1 builder for plaintext without h2c (h1 only) with a read timeout.
fn build_h1(t: &Tuning) -> http1::Builder {
    let mut b = http1::Builder::new();
    b.timer(TokioTimer::new());
    if let Some(to) = t.header_read_timeout {
        b.header_read_timeout(to);
    }
    if let Some(m) = t.max_headers {
        b.max_headers(m);
    }
    if let Some(sz) = t.max_header_size {
        b.max_buf_size(sz.max(MIN_HEADER_BUF));
    }
    b
}

/// Shutdown stages (§10 + §11). Connections react only to `CLOSING`.
pub const RUNNING: u8 = 0;
/// Readiness dropped, listener still accepting: waiting for the balancer to pull the pod.
pub const PRE_SHUTDOWN: u8 = 1;
/// Stop accepting and ask connections to close.
pub const CLOSING: u8 = 2;

/// Wait for the `CLOSING` stage (the intermediate `PRE_SHUTDOWN` is ignored).
async fn wait_closing(rx: &mut watch::Receiver<u8>) {
    loop {
        if *rx.borrow_and_update() >= CLOSING {
            return;
        }
        if rx.changed().await.is_err() {
            return; // the sender is gone — treat it as an order to close
        }
    }
}

/// Serve a connection to completion, reacting to the idle timeout and graceful shutdown.
///
/// - idle expired → the future is dropped and the socket closes;
/// - `CLOSING` arrived → `graceful_shutdown()` (that is `GOAWAY` for h2; for h1 it means
///   finishing the current request and not taking the next one over keep-alive), then we
///   wait for completion.
async fn drive<C: GracefulConnection>(
    conn: C,
    idle: Option<(Activity, Duration)>,
    mut shutdown: watch::Receiver<u8>,
    shed: Arc<Notify>,
) {
    tokio::pin!(conn);
    let idle_wait = async {
        match idle {
            Some((activity, dur)) => watch_idle(activity, dur).await,
            // No idle timeout → this branch must never win the race.
            None => std::future::pending().await,
        }
    };
    tokio::pin!(idle_wait);

    tokio::select! {
        _ = conn.as_mut() => return,
        _ = &mut idle_wait => return,
        _ = wait_closing(&mut shutdown) => {}
        // Overload: the 503 response is already being built; close the connection next.
        _ = shed.notified() => {}
    }

    // Graceful phase: ask the connection to close and let it finish the current request.
    // The deadline is global (held by the accept loop); here only idle remains as a guard.
    conn.as_mut().graceful_shutdown();
    tokio::select! {
        _ = conn => {}
        _ = idle_wait => {}
    }
}

/// Accept loop and graceful shutdown (§10).
///
/// On the `shutdown` signal: stop accepting connections and close the listener right
/// away (the port frees up for a replacement pod), then let open connections finish
/// their requests until `shutdown_timeout`. Once the drain is done (or the deadline
/// expires) we signal `done`.
pub async fn serve(
    listener: Bound,
    shared: Arc<Shared>,
    shutdown: watch::Receiver<u8>,
    done: Arc<Notify>,
) {
    // Builders are constructed once and shared into tasks via Arc (serve_connection(&self)).
    let auto_builder = Arc::new(build_auto(&shared.tuning));
    let h1_builder = Arc::new(build_h1(&shared.tuning));

    // Drain detector: each task holds a clone of the sender. Once every connection is
    // done, all clones are dropped and recv() returns None — no counters needed.
    let (drain_tx, mut drain_rx) = mpsc::channel::<()>(1);
    let mut shutdown_acc = shutdown.clone();
    // Live connections — for maxConnections (§6c B9).
    let live = Arc::new(AtomicUsize::new(0));

    loop {
        // accept for both socket types: a Unix peer is anonymous, so we use a stand-in
        // address. PRE_SHUTDOWN does not stop accepting: in that window readiness is
        // already down, but the pod still serves traffic the balancer has not moved yet.
        let accepted = tokio::select! {
            _ = wait_closing(&mut shutdown_acc) => break,
            a = accept_any(&listener) => a,
        };
        let (stream, peer_ip) = match accepted {
            Some(v) => v,
            None => continue, // transient accept error — skip it
        };

        // Connection limit: above it we close immediately, spending no task or memory.
        if let Some(max) = shared.tuning.max_connections {
            if live.load(Ordering::Relaxed) >= max {
                drop(stream);
                continue;
            }
        }
        live.fetch_add(1, Ordering::Relaxed);

        let ctx = ConnCtx {
            shared: shared.clone(),
            auto_builder: auto_builder.clone(),
            h1_builder: h1_builder.clone(),
            shutdown: shutdown.clone(),
            live: live.clone(),
        };
        let drain = drain_tx.clone();
        match stream {
            AnyStream::Tcp(s) => {
                if shared.tuning.socket.nodelay {
                    let _ = s.set_nodelay(true);
                }
                tokio::spawn(async move {
                    let _drain = drain;
                    serve_conn(s, peer_ip, ctx).await;
                });
            }
            AnyStream::Unix(s) => {
                tokio::spawn(async move {
                    let _drain = drain;
                    serve_conn(s, peer_ip, ctx).await;
                });
            }
        }
    }

    // Close the listener immediately: the port frees before the drain finishes so a
    // replacement pod can bind while we are still finishing old requests.
    drop(listener);

    // Wait until connection tasks release their drain_tx clones — but not past the deadline.
    drop(drain_tx);
    let deadline = shared.tuning.shutdown_timeout;
    tokio::select! {
        _ = drain_rx.recv() => {}
        _ = tokio::time::sleep(deadline) => {}
    }
    done.notify_one();
}

/// An accepted connection: TCP or Unix.
enum AnyStream {
    Tcp(tokio::net::TcpStream),
    Unix(tokio::net::UnixStream),
}

/// Shared accept for both listener types. `None` — a transient error.
async fn accept_any(listener: &Bound) -> Option<(AnyStream, String)> {
    match listener {
        Bound::Tcp(l) => match l.accept().await {
            Ok((s, peer)) => Some((AnyStream::Tcp(s), peer.ip().to_string())),
            Err(_) => None,
        },
        Bound::Unix(l) => match l.accept().await {
            // A Unix socket has no peer address: we return loopback so `c.req.ip`
            // stays non-empty (the §7 invariant), and the real source arrives via
            // customIpHeaders — behind a unix socket there is always a local proxy.
            Ok((s, _)) => Some((AnyStream::Unix(s), "127.0.0.1".to_string())),
            Err(_) => None,
        },
    }
}

/// Everything the connection task needs from the server (instead of six arguments).
struct ConnCtx {
    shared: Arc<Shared>,
    auto_builder: Arc<auto::Builder<TokioExecutor>>,
    h1_builder: Arc<http1::Builder>,
    shutdown: watch::Receiver<u8>,
    live: Arc<AtomicUsize>,
}

/// Serve a single connection: PROXY prefix → TLS/ALPN → h1/h2 → drain.
async fn serve_conn<S>(stream: S, peer_ip: String, ctx: ConnCtx)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // The live-connection counter is released in every case (including an early return).
    let _live = LiveGuard(ctx.live);
    let shared = ctx.shared;
    shared.metrics.conn_opened();
    let _conn_metric = ConnMetricGuard(shared.clone());
    let tuning = &shared.tuning;

    // PROXY protocol (§6c A4) — strictly before TLS: the prefix arrives raw ahead of
    // the handshake.
    let (stream, peer_ip) = if tuning.proxy_protocol {
        // The prefix is read before TLS and before the stream is wrapped in ActivityIo,
        // so `handshake_timeout` is the only guard here — without it a client that
        // connects and stays quiet parks a task and an FD indefinitely.
        match maybe_timeout(tuning.handshake_timeout, proxy_protocol::read_header(stream)).await {
            Some(Ok((io, addr))) => (io, addr.unwrap_or(peer_ip)),
            // Missing prefix, malformed prefix, or silence — not from our balancer.
            _ => return,
        }
    } else {
        (proxy_protocol::PrefixedIo::new(stream, Vec::new()), peer_ip)
    };

    // The activity tracker sits before TLS: the handshake counts as activity too, and
    // idle behaves identically for h1/h2/TLS.
    let activity = Activity::new();
    let svc_activity = activity.clone();
    let svc_shared = shared.clone();
    // The "close this connection" signal: the handler sends it on overload and `drive`
    // catches it in the same place it handles the global shutdown (§6c C5).
    let shed = Arc::new(Notify::new());
    let svc_shed = shed.clone();
    let service = service_fn(move |req: Request<Incoming>| {
        let shared = svc_shared.clone();
        let peer_ip = peer_ip.clone();
        let shed = svc_shed.clone();
        // The guard keeps the connection "busy" while the handler runs: slow processing
        // must not look like idleness.
        let guard = svc_activity.request_guard();
        async move {
            let res = handle(req, shared, peer_ip, shed).await;
            drop(guard);
            Ok::<_, Infallible>(res)
        }
    });

    let idle = tuning.idle_timeout.map(|d| (activity.clone(), d));
    let stream = ActivityIo::new(stream, activity);

    // Connection errors are swallowed: the process must not go down.
    if let Some(acceptor) = tuning.tls.clone() {
        // TLS: handshake with a timeout → ALPN decides h2/h1.1.
        if let Some(Ok(tls_stream)) =
            maybe_timeout(tuning.handshake_timeout, acceptor.accept(stream)).await
        {
            let io = TokioIo::new(tls_stream);
            drive(
                ctx.auto_builder.serve_connection(io, service),
                idle,
                ctx.shutdown,
                shed,
            )
            .await;
        }
    } else if tuning.h2c {
        // plaintext + h2c prior-knowledge → auto (h1 + h2).
        let io = TokioIo::new(stream);
        drive(
            ctx.auto_builder.serve_connection(io, service),
            idle,
            ctx.shutdown,
            shed,
        )
        .await;
    } else {
        // plaintext, HTTP/1.1 only.
        let io = TokioIo::new(stream);
        drive(
            ctx.h1_builder.serve_connection(io, service),
            idle,
            ctx.shutdown,
            shed,
        )
        .await;
    }
}

/// Decrements the live-connection counter on Drop (including on a task panic).
struct LiveGuard(Arc<AtomicUsize>);

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Removes the connection from the metrics gauge on Drop.
struct ConnMetricGuard(Arc<Shared>);

impl Drop for ConnMetricGuard {
    fn drop(&mut self) {
        self.0.metrics.conn_closed();
    }
}

/// Separate port for probes and metrics (§11): h1 only, admin paths only.
///
/// The point of the split is to keep `/metrics` off the public surface: the main port
/// is published via Service/Ingress while the admin port stays inside the cluster for
/// Prometheus and kubelet.
pub async fn serve_admin(
    listener: tokio::net::TcpListener,
    shared: Arc<Shared>,
    mut shutdown: watch::Receiver<u8>,
) {
    // Same hardening as the main port. A bare `http1::Builder::new()` has no timer, so
    // hyper's header-read timeout does not apply at all, and nothing reclaims an idle
    // socket — a Slowloris from inside the cluster is still a Slowloris.
    let builder = Arc::new(build_h1(&shared.tuning));
    let live = Arc::new(AtomicUsize::new(0));
    loop {
        let accepted = tokio::select! {
            _ = wait_closing(&mut shutdown) => break,
            a = listener.accept() => a,
        };
        let Ok((stream, _)) = accepted else { continue };
        if let Some(max) = shared.tuning.max_connections {
            if live.load(Ordering::Relaxed) >= max {
                drop(stream);
                continue;
            }
        }
        live.fetch_add(1, Ordering::Relaxed);
        let shared = shared.clone();
        let builder = builder.clone();
        let live = live.clone();
        let conn_shutdown = shutdown.clone();
        tokio::spawn(async move {
            let _live = LiveGuard(live);
            let activity = Activity::new();
            let idle = shared.tuning.idle_timeout.map(|d| (activity.clone(), d));
            let io = ActivityIo::new(stream, activity);
            let service = service_fn(move |req: Request<Incoming>| {
                let shared = shared.clone();
                async move {
                    let method = req.method().as_str().to_uppercase();
                    let res = admin_response(&shared, &method, req.uri().path())
                        .unwrap_or_else(|| status_text(404, "Not Found"));
                    Ok::<_, Infallible>(res)
                }
            });
            drive(
                builder.serve_connection(TokioIo::new(io), service),
                idle,
                conn_shutdown,
                Arc::new(Notify::new()),
            )
            .await;
        });
    }
}

/// Run a request through the whole pipeline **without a socket** (§17, `app.inject`).
///
/// The connection is a `tokio::io::duplex` — memory instead of the network. This is not
/// a mock: the same `handle`, routing, schemas, CORS, metrics and JS onion all run, the
/// bytes simply never leave the process. Returns status, headers and the response body.
pub async fn inject(
    shared: Arc<Shared>,
    req: Request<Full<Bytes>>,
) -> Result<(u16, Vec<KvPair>, Bytes), String> {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);

    // Server side of the pipe: the same path a real connection takes.
    let srv = shared.clone();
    tokio::spawn(async move {
        let shed = Arc::new(Notify::new());
        let service = service_fn(move |r: Request<Incoming>| {
            let srv = srv.clone();
            let shed = shed.clone();
            async move { Ok::<_, Infallible>(handle(r, srv, "127.0.0.1".to_string(), shed).await) }
        });
        let _ = http1::Builder::new()
            .serve_connection(TokioIo::new(server_io), service)
            .await;
    });

    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(client_io))
        .await
        .map_err(|e| format!("inject handshake: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let res = sender
        .send_request(req)
        .await
        .map_err(|e| format!("inject request: {e}"))?;
    let status = res.status().as_u16();
    let headers = collect_headers(res.headers());
    let body = res
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("inject body: {e}"))?
        .to_bytes();

    Ok((status, headers, body))
}

/// Per-request data computed once and then moved into the dispatcher.
struct ReqData {
    method: String,
    path: String,
    query_string: Option<String>,
    query: Vec<KvPair>,
    headers: Vec<KvPair>,
}

/// A single request. Rust edges (CORS preflight, body-limit) → routing/dispatch →
/// attaching CORS headers to the final response.
async fn handle(
    req: Request<Incoming>,
    shared: Arc<Shared>,
    peer_ip: String,
    shed: Arc<Notify>,
) -> Response<ResBody> {
    let started = std::time::Instant::now();
    let method_for_metrics = req.method().as_str().to_uppercase();
    let path_for_log = req.uri().path().to_string();

    shared.metrics.request_started();

    // Probes and metrics (§11) come before the limiter: under overload `/readyz` must
    // still answer, otherwise k8s never learns the pod should leave the endpoints.
    let probe = if shared.tuning.admin_port.is_none() {
        admin_response(&shared, &method_for_metrics, req.uri().path())
    } else {
        None
    };

    let response = match (probe, &shared.overload) {
        (Some(res), _) => res,
        // Concurrent request limit (§6c C5). The permit is held for the whole handling;
        // beyond the limit and the queue — 503 + Retry-After.
        (None, Some(limiter)) => match limiter.acquire().await {
            Slot::Acquired(permit) => {
                // A slot was free → the overload streak is over, restore readiness.
                shared.readiness.set_overloaded(false);
                let res = handle_inner(req, &shared, peer_ip).await;
                drop(permit);
                res
            }
            Slot::Rejected { retry_after } => {
                // Sustained overload → drop readiness (layer 2, §6c C5).
                shared.readiness.set_overloaded(limiter.should_shed());
                // Ask the connection to close: for h2 that is GOAWAY — the client
                // reconnects, possibly to another pod. For h1 it closes keep-alive after
                // the response, with the same effect.
                shed.notify_one();
                overloaded_response(retry_after)
            }
        },
        (None, None) => handle_inner(req, &shared, peer_ip).await,
    };

    let elapsed = started.elapsed();
    let status = response.status().as_u16();
    shared
        .metrics
        .request_finished(&method_for_metrics, status, elapsed);
    if shared.tuning.access_log {
        access_log(&method_for_metrics, &path_for_log, status, elapsed);
    }
    response
}

/// Overload response (§6c C5): 503 + Retry-After so a retry-capable ingress/mesh moves
/// the request to another replica and the client knows when to try again.
fn overloaded_response(retry_after: u64) -> Response<ResBody> {
    builder_or_500(
        Response::builder()
            .status(503)
            .header("retry-after", retry_after.to_string())
            .header("content-type", "text/plain; charset=utf-8"),
        full("Service Unavailable"),
    )
}

/// Probes and metrics (§11). `None` — not our path, handle it as a regular request.
///
/// Answered entirely in Rust: k8s hits the probes once a second and waking JS for that
/// is pointless. `/readyz` returns 503 during drain/overload — k8s then pulls the pod
/// from the endpoints.
fn admin_response(shared: &Shared, method: &str, path: &str) -> Option<Response<ResBody>> {
    if method != "GET" && method != "HEAD" {
        return None;
    }
    let p = &shared.tuning.health_paths;

    if !p.health.is_empty() && path == p.health {
        return Some(builder_or_500(
            Response::builder()
                .status(200)
                .header("content-type", "text/plain; charset=utf-8")
                .header("cache-control", "no-store"),
            full("ok"),
        ));
    }

    if !p.ready.is_empty() && path == p.ready {
        let ready = shared.readiness.is_ready();
        return Some(builder_or_500(
            Response::builder()
                .status(if ready { 200 } else { 503 })
                .header("content-type", "text/plain; charset=utf-8")
                .header("cache-control", "no-store"),
            full(shared.readiness.reason()),
        ));
    }

    if !p.metrics.is_empty() && path == p.metrics {
        return Some(builder_or_500(
            Response::builder()
                .status(200)
                .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
                .header("cache-control", "no-store"),
            full_owned(shared.metrics.encode()),
        ));
    }

    None
}

/// Access log line to stdout: one JSON line per request (§11).
///
/// Written from Rust so the log never wakes JS. Fields are assembled by hand without
/// serde: only the path needs escaping (method and numbers are safe by construction).
fn access_log(method: &str, path: &str, status: u16, elapsed: std::time::Duration) {
    let ms = elapsed.as_secs_f64() * 1000.0;
    println!(
        r#"{{"level":"info","msg":"request","method":"{}","path":"{}","status":{},"durationMs":{:.3}}}"#,
        method,
        escape_json(path),
        status,
        ms
    );
}

/// Minimal string escaping for the JSON log.
fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The request handling body (metrics/logging are added by `handle`).
async fn handle_inner(
    req: Request<Incoming>,
    shared: &Arc<Shared>,
    peer_ip: String,
) -> Response<ResBody> {
    let (parts, incoming) = req.into_parts();
    let method = parts.method.as_str().to_uppercase();
    let origin = header_str(&parts.headers, "origin");

    // CORS preflight at the edge: OPTIONS + Access-Control-Request-Method → answered in
    // Rust WITHOUT waking JS (§6a). A rejected origin → 403.
    if let Some(cors) = &shared.cors {
        let is_preflight =
            method == "OPTIONS" && parts.headers.contains_key("access-control-request-method");
        if is_preflight {
            let req_headers = header_str(&parts.headers, "access-control-request-headers");
            return match cors.preflight(origin.as_deref(), req_headers.as_deref()) {
                Some(headers) => pairs_response(204, headers),
                None => status_text(403, "Forbidden"),
            };
        }
    }

    // Early refusal: the declared Content-Length already exceeds the limit → 413 right
    // away without reading the body (DoS guard before JS wakes). The authoritative check
    // counts actual bytes in read_body_task (Content-Length may lie or be absent).
    if let (Some(limit), Some(cl)) = (shared.body_limit, content_length(&parts.headers)) {
        if cl > limit {
            return apply_cors(
                shared,
                origin.as_deref(),
                status_text(413, "Payload Too Large"),
            );
        }
    }

    let has_body = request_has_body(&parts.headers);
    let path = parts.uri.path().to_string();
    let query_string = parts.uri.query().map(|s| s.to_string());
    let data = ReqData {
        query: parse_query(query_string.as_deref()),
        headers: collect_headers(&parts.headers),
        method,
        path,
        query_string,
    };

    let response = route_and_dispatch(shared, &peer_ip, data, incoming, has_body).await;
    apply_cors(shared, origin.as_deref(), response)
}

/// Routing plus dispatch into JS (no CORS here — `handle` wraps that).
async fn route_and_dispatch(
    shared: &Arc<Shared>,
    peer_ip: &str,
    data: ReqData,
    incoming: Incoming,
    has_body: bool,
) -> Response<ResBody> {
    // 1. Direct match (method-specific tree or ALL).
    if let Some(m) = shared.routes.match_route(&data.method, &data.path) {
        return dispatch(
            shared, peer_ip, m.leaf_id, data, m.params, false, incoming, has_body,
        )
        .await;
    }

    // 2. Auto-HEAD: no HEAD route → try GET and strip the body.
    if data.method == "HEAD" {
        if let Some(m) = shared.routes.match_route("GET", &data.path) {
            return dispatch(
                shared, peer_ip, m.leaf_id, data, m.params, true, incoming, has_body,
            )
            .await;
        }
    }

    // 3. The path did not match under this method. 404 vs 405 vs auto-OPTIONS.
    let allowed = shared.routes.allowed_methods(&data.path);

    if allowed.is_empty() {
        if shared.has_not_found {
            return dispatch(
                shared,
                peer_ip,
                -1,
                data,
                HashMap::new(),
                false,
                incoming,
                has_body,
            )
            .await;
        }
        return status_text(404, "Not Found");
    }

    let allow = allowed.join(", ");

    if data.method == "OPTIONS" {
        return builder_or_500(
            Response::builder().status(204).header("allow", allow),
            empty(),
        );
    }

    builder_or_500(
        Response::builder().status(405).header("allow", allow),
        full("Method Not Allowed"),
    )
}

/// Attach CORS headers to a regular response (when the origin is allowed).
fn apply_cors(
    shared: &Shared,
    origin: Option<&str>,
    mut response: Response<ResBody>,
) -> Response<ResBody> {
    if let Some(cors) = &shared.cors {
        let headers = response.headers_mut();
        for (k, v) in cors.actual(origin) {
            if let (Ok(name), Ok(value)) = (
                hyper::header::HeaderName::from_bytes(k.as_bytes()),
                hyper::header::HeaderValue::from_str(&v),
            ) {
                headers.append(name, value);
            }
        }
    }
    response
}

/// Header value as a string (the first one when several are present).
fn header_str(headers: &hyper::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Response from a status plus header pairs (for CORS preflight).
fn pairs_response(status: u16, headers: Vec<(String, String)>) -> Response<ResBody> {
    let mut builder = Response::builder().status(status);
    for (k, v) in headers {
        builder = builder.header(k, v);
    }
    builder_or_500(builder, empty())
}

/// Call the JS dispatcher, await the `Promise`, assemble the HTTP response.
#[allow(clippy::too_many_arguments)]
async fn dispatch(
    shared: &Shared,
    peer_ip: &str,
    leaf_id: i32,
    data: ReqData,
    params: HashMap<String, String>,
    head: bool,
    incoming: Incoming,
    has_body: bool,
) -> Response<ResBody> {
    let (ip, ips, country) = client_ip_country(
        &data.headers,
        &shared.custom_ip_headers,
        &shared.custom_country_headers,
        peer_ip,
    );
    let id = request_id(&data.headers, &shared.request_id_header);

    // This leaf's schema (notFound / no schema → None).
    let schema = if leaf_id >= 0 {
        shared
            .schemas
            .get(leaf_id as usize)
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    // This leaf's multipart config.
    let multipart_cfg = if leaf_id >= 0 {
        shared
            .multipart
            .get(leaf_id as usize)
            .and_then(|o| o.as_ref())
    } else {
        None
    };

    let mut incoming = Some(incoming);
    let mut mp_rx = None;

    // Multipart route: check Content-Type → 415, extract the boundary → parse streaming.
    if let Some(cfg) = multipart_cfg {
        let ct = data
            .headers
            .iter()
            .find(|kv| kv.key == "content-type")
            .map(|kv| kv.value.as_str());
        match ct.and_then(|c| multer::parse_boundary(c).ok()) {
            Some(boundary) => {
                let (tx, rx) = mpsc::channel::<crate::multipart::MpEvent>(BODY_CHANNEL_CAP);
                tokio::spawn(crate::multipart::parse_task(
                    incoming.take().unwrap(),
                    boundary,
                    cfg.clone(),
                    tx,
                ));
                mp_rx = Some(rx);
            }
            None => return status_text(415, "Unsupported Media Type"),
        }
    }

    // The body is buffered in Rust for native validation of a non-multipart body. A
    // compressed body is buffered too and decoded here: skipping it used to make the
    // validator see "no body" and reject every compressed request with 400.
    let encoding = content_encoding(&data.headers);
    let buffer_for_schema =
        multipart_cfg.is_none() && schema.is_some_and(|s| s.has_body()) && has_body;

    let mut buffered: Option<Bytes> = None;
    // Tells JS the payload it receives is already decoded, so it must not decode again.
    let mut body_decoded = false;
    if buffer_for_schema {
        let raw = match buffer_body(
            incoming.take().unwrap(),
            shared.body_limit,
            shared.tuning.body_read_timeout,
        )
        .await
        {
            Ok(b) => b,
            Err(BodyErr::TooLarge) => return status_text(413, "Payload Too Large"),
            Err(BodyErr::Timeout) => return status_text(408, "Request Timeout"),
            Err(BodyErr::Aborted) => return status_text(400, "Bad Request"),
        };
        buffered = Some(match &encoding {
            None => raw,
            Some(enc) => match crate::compress::decode(enc, &raw, shared.body_limit) {
                Ok(decoded) => {
                    body_decoded = true;
                    decoded
                }
                Err(crate::compress::DecodeErr::Unsupported) => {
                    return status_text(415, "Unsupported Media Type")
                }
                Err(crate::compress::DecodeErr::TooLarge) => {
                    return status_text(413, "Payload Too Large")
                }
                Err(crate::compress::DecodeErr::Invalid) => {
                    return status_text(400, "Invalid compressed body")
                }
            },
        });
    }

    // Structural validation in Rust → 400 without waking JS (§6b). Body: non-multipart only.
    let mut validated = crate::schema::Validated::default();
    if let Some(schema) = schema {
        let body_bytes = if buffer_for_schema {
            buffered.as_deref()
        } else {
            None
        };
        match schema.validate(&data.query, &params, body_bytes) {
            Ok(v) => validated = v,
            Err(issues) => return validation_response(&issues),
        }
    }

    // Request body channel. Buffered content goes out as one chunk; multipart has no
    // regular body.
    let req_rx = if multipart_cfg.is_some() {
        None
    } else if let Some(b) = buffered {
        let (tx, rx) = mpsc::channel::<BodyMsg>(1);
        let _ = tx.try_send(BodyMsg::Data(b)); // fits (cap 1), then we close
        Some(rx)
    } else if has_body {
        let (tx, rx) = mpsc::channel::<BodyMsg>(BODY_CHANNEL_CAP);
        tokio::spawn(read_body_task(
            incoming.take().unwrap(),
            tx,
            shared.body_limit,
            shared.tuning.body_read_timeout,
            shared.metrics.clone(),
        ));
        Some(rx)
    } else {
        None
    };

    // Response body channel (used when the handler streams).
    let (resp_tx, resp_rx) = mpsc::channel::<Bytes>(BODY_CHANNEL_CAP);

    // Disconnect detection. Everything above this point returns early without ever
    // reaching JS, so the guard is created here — after the last early return — and any
    // drop from now on means hyper gave up on the connection.
    let abort = Arc::new(AbortSignal::new());
    let _abort_guard = AbortGuard(abort.clone());
    let body_io = BodyIo::new(req_rx, Some(resp_tx), mp_rx, abort.clone());

    let req = MatchedRequest {
        leaf_id,
        method: data.method,
        path: data.path,
        query_string: data.query_string,
        params,
        query: data.query,
        headers: data.headers,
        ip,
        ips,
        country,
        id,
        body_decoded,
        valid_body: validated.body,
        valid_query: validated.query,
        valid_params: validated.params,
    };

    let response = match shared.tsfn.call_async((req, body_io)).await {
        Ok(promise) => match promise.await {
            Ok(res) => build_response(res, head, resp_rx, &shared.metrics),
            Err(_) => status_text(500, "Internal Server Error"),
        },
        Err(_) => status_text(500, "Internal Server Error"),
    };
    // Reached only if the future was never dropped, i.e. the request really finished.
    abort.complete();
    response
}

/// Fires the abort signal when the request future is dropped. Hyper drops it as soon as
/// the connection dies, which is the only client-disconnect notification we get.
struct AbortGuard(Arc<AbortSignal>);

impl Drop for AbortGuard {
    fn drop(&mut self) {
        self.0.fire();
    }
}

/// Background task: reads the request body frame by frame into the channel
/// (backpressure via the channel capacity).
///
/// Authoritative body-limit: we count **actual** bytes (never trusting Content-Length).
/// On overflow we send `Overflow` and stop reading the socket — JS cannot bypass this.
async fn read_body_task(
    mut body: Incoming,
    tx: Sender<BodyMsg>,
    limit: Option<u64>,
    read_timeout: Option<Duration>,
    metrics: Arc<Metrics>,
) {
    let mut total: u64 = 0;
    loop {
        // The timeout covers waiting for a chunk, not the whole body: a slow but live
        // upload succeeds, while a Slowloris-style body upload is cut off (§6c A2).
        let next = match read_timeout {
            Some(to) => match tokio::time::timeout(to, body.frame()).await {
                Ok(v) => v,
                Err(_) => {
                    let _ = tx.send(BodyMsg::Timeout).await;
                    return;
                }
            },
            None => body.frame().await,
        };
        let frame = match next {
            Some(Ok(f)) => f,
            // A read error part-way through means the client vanished. Treating it as a
            // clean end would give JS a truncated body it believes is complete.
            Some(Err(_)) => {
                let _ = tx.send(BodyMsg::Aborted).await;
                return;
            }
            None => break, // end of body
        };
        if let Ok(data) = frame.into_data() {
            total = total.saturating_add(data.len() as u64);
            metrics.add_request_bytes(data.len() as u64);
            if limit.is_some_and(|lim| total > lim) {
                let _ = tx.send(BodyMsg::Overflow).await;
                return; // stop reading the body (DoS guard)
            }
            if tx.send(BodyMsg::Data(data)).await.is_err() {
                break; // the receiver is gone (JS stopped reading)
            }
        }
    }
}

/// The Content-Length value when valid.
fn content_length(headers: &hyper::HeaderMap) -> Option<u64> {
    headers
        .get(hyper::header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()
}

/// Why the body could not be read: limit exceeded (413), client silence (408), or the
/// connection dying part-way through (400).
enum BodyErr {
    TooLarge,
    Timeout,
    Aborted,
}

/// Buffer the whole body (for native validation), honouring the limit and read timeout.
async fn buffer_body(
    mut body: Incoming,
    limit: Option<u64>,
    read_timeout: Option<Duration>,
) -> Result<Bytes, BodyErr> {
    let mut buf = BytesMut::new();
    loop {
        let next = match read_timeout {
            Some(to) => match tokio::time::timeout(to, body.frame()).await {
                Ok(v) => v,
                Err(_) => return Err(BodyErr::Timeout),
            },
            None => body.frame().await,
        };
        let frame = match next {
            Some(Ok(f)) => f,
            // Truncated body — never validate a partial payload as if it were whole.
            Some(Err(_)) => return Err(BodyErr::Aborted),
            None => break, // end of body
        };
        if let Ok(data) = frame.into_data() {
            if limit.is_some_and(|l| buf.len() as u64 + data.len() as u64 > l) {
                return Err(BodyErr::TooLarge);
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(buf.freeze())
}

/// The active `Content-Encoding` (lowercased), or `None` when absent or `identity`.
fn content_encoding(headers: &[KvPair]) -> Option<String> {
    headers
        .iter()
        .find(|kv| kv.key == "content-encoding")
        .and_then(|kv| {
            let v = kv.value.trim().to_lowercase();
            if v.is_empty() || v == "identity" {
                None
            } else {
                Some(v)
            }
        })
}

/// A `400` response with the validation error list (machine-readable, without waking JS).
fn validation_response(issues: &[crate::schema::Issue]) -> Response<ResBody> {
    let body = crate::schema::errors_body(issues);
    builder_or_500(
        Response::builder()
            .status(400)
            .header("content-type", "application/json; charset=utf-8"),
        Full::new(Bytes::from(body)).boxed(),
    )
}

/// Whether the request has a body (content-length>0 or transfer-encoding).
fn request_has_body(headers: &hyper::HeaderMap) -> bool {
    if headers.contains_key(hyper::header::TRANSFER_ENCODING) {
        return true;
    }
    content_length(headers).is_some_and(|n| n > 0)
}

fn collect_headers(headers: &hyper::HeaderMap) -> Vec<KvPair> {
    headers
        .iter()
        .map(|(k, v)| KvPair {
            key: k.as_str().to_string(), // http::HeaderName is already lowercase
            value: v.to_str().unwrap_or("").to_string(),
        })
        .collect()
}

/// `ip`/`ips`/`country` per §7: the first non-empty custom header, XFF split on commas.
fn client_ip_country(
    headers: &[KvPair],
    ip_headers: &[String],
    country_headers: &[String],
    peer_ip: &str,
) -> (String, Vec<String>, Option<String>) {
    let first_present = |names: &[String]| -> Option<String> {
        for name in names {
            let lname = name.to_lowercase();
            if let Some(kv) = headers.iter().find(|kv| kv.key == lname) {
                let v = kv.value.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
        None
    };

    let (ip, ips) = match first_present(ip_headers) {
        Some(val) => {
            let parts: Vec<String> = val
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let ip = parts
                .first()
                .cloned()
                .unwrap_or_else(|| peer_ip.to_string());
            let ips = if parts.is_empty() {
                vec![peer_ip.to_string()]
            } else {
                parts
            };
            (ip, ips)
        }
        None => (peer_ip.to_string(), vec![peer_ip.to_string()]),
    };

    let country = first_present(country_headers).map(|c| c.trim().to_uppercase());
    (ip, ips, country)
}

/// request-id from the header, or a fresh UUIDv7 (§6d B2).
fn request_id(headers: &[KvPair], id_header: &str) -> String {
    let lname = id_header.to_lowercase();
    if let Some(kv) = headers.iter().find(|kv| kv.key == lname) {
        let v = kv.value.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }
    uuid::Uuid::now_v7().to_string()
}

fn parse_query(q: Option<&str>) -> Vec<KvPair> {
    match q {
        Some(s) => form_urlencoded::parse(s.as_bytes())
            .map(|(k, v)| KvPair {
                key: k.into_owned(),
                value: v.into_owned(),
            })
            .collect(),
        None => Vec::new(),
    }
}

fn build_response(
    res: JsResponse,
    head: bool,
    resp_rx: Receiver<Bytes>,
    metrics: &Metrics,
) -> Response<ResBody> {
    let mut builder = Response::builder().status(res.status.unwrap_or(200));
    if let Some(headers) = res.headers {
        for kv in headers {
            // .header() appends — multiple set-cookie values are preserved.
            builder = builder.header(kv.key, kv.value);
        }
    }

    let streamed = res.streamed.unwrap_or(false);

    // HEAD: we send no body but keep the content-length of the string body.
    if head {
        if let Some(headers) = builder.headers_mut() {
            let len = res.body.as_ref().map(|b| b.len()).unwrap_or(0);
            if !streamed && !headers.contains_key("content-length") {
                if let Ok(v) = len.to_string().parse() {
                    headers.insert("content-length", v);
                }
            }
        }
        return builder_or_500(builder, empty());
    }

    if streamed {
        return builder_or_500(builder, ChannelBody::new(resp_rx).boxed());
    }

    let bytes = Bytes::from(res.body.unwrap_or_default());
    metrics.add_response_bytes(bytes.len() as u64);
    builder_or_500(builder, Full::new(bytes).boxed())
}

fn full(text: &'static str) -> ResBody {
    Full::new(Bytes::from_static(text.as_bytes())).boxed()
}

/// Body from an owned string (metrics are assembled on the fly, statics won't do).
fn full_owned(text: String) -> ResBody {
    Full::new(Bytes::from(text)).boxed()
}

fn empty() -> ResBody {
    Full::new(Bytes::new()).boxed()
}

fn status_text(code: u16, text: &'static str) -> Response<ResBody> {
    Response::builder()
        .status(code)
        .body(full(text))
        .expect("static response is always valid")
}

/// Build a response from builder+body; on error (an invalid header) — 500.
fn builder_or_500(builder: hyper::http::response::Builder, body: ResBody) -> Response<ResBody> {
    builder
        .body(body)
        .unwrap_or_else(|_| status_text(500, "Internal Server Error"))
}
