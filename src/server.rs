//! tokio + hyper: accept-цикл и обслуживание запроса (HTTP/1.1).
//!
//! Края в Rust (§6a): CORS preflight и body-limit обрываются до пробуждения JS.
//! Тело запроса читается в канал (backpressure JS→Rust), тело ответа может
//! стримиться через канальный `Body` (backpressure Rust→JS). См. stream.rs / cors.rs.

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
use crate::stream::{BodyIo, BodyMsg, ChannelBody, BODY_CHANNEL_CAP};

/// Параметры протокола/безопасности (TLS, h2, read-таймауты) — §12, §6c A1/A2.
pub struct Tuning {
    pub tls: Option<TlsAcceptor>,
    pub h2c: bool,
    pub header_read_timeout: Option<Duration>,
    /// Таймаут ожидания следующего чанка тела запроса (§6c A2) → 408.
    pub body_read_timeout: Option<Duration>,
    /// Простой соединения без чтения/записи (§6c A2). Покрывает и h1 keep-alive.
    pub idle_timeout: Option<Duration>,
    /// Дедлайн drain'а при graceful shutdown (§10); истёк — рвём что осталось.
    pub shutdown_timeout: Duration,
    /// Опции сокета (§6c B9); из них в accept-цикле нужен `nodelay`.
    pub socket: SocketOptions,
    /// Потолок одновременных соединений (§6c B9). None = без лимита.
    pub max_connections: Option<usize>,
    /// Ждать PROXY-префикс на каждом соединении (§6c A4).
    pub proxy_protocol: bool,
    /// Пути проб и метрик (§11); пустая строка = ручка выключена.
    pub health_paths: HealthPaths,
    /// Отдельный порт для проб/метрик (§11). Some → на основном порту их нет.
    pub admin_port: Option<u16>,
    /// Печатать access-log в stdout строкой JSON (§11).
    pub access_log: bool,
    pub handshake_timeout: Duration,
    pub max_headers: Option<usize>,
    /// Предел размера блока заголовков; превышение → 431 (§6c B10).
    pub max_header_size: Option<usize>,
    pub max_concurrent_streams: Option<u32>,
    pub initial_window_size: Option<u32>,
    pub max_reset_streams: Option<usize>,
}

/// Нижняя граница буфера чтения в hyper: меньше — паника внутри `max_buf_size`.
const MIN_HEADER_BUF: usize = 8192;

/// Единый тип тела ответа: буфер (`Full`) либо стрим (`ChannelBody`).
type ResBody = BoxBody<Bytes, Infallible>;

/// Общее состояние, разделяемое между соединениями.
pub struct Shared {
    pub tsfn: Handler,
    pub routes: Routes,
    pub has_not_found: bool,
    pub custom_ip_headers: Vec<String>,
    pub custom_country_headers: Vec<String>,
    pub request_id_header: String,
    /// Жёсткий лимит тела запроса в байтах (авторитетный, в Rust). None = без лимита.
    pub body_limit: Option<u64>,
    /// Нативный CORS (края луковицы). None = выключен.
    pub cors: Option<Cors>,
    /// Скомпилированные схемы по leaf_id (валидация вне event loop). Пустой = без схем.
    pub schemas: Vec<crate::schema::LeafSchema>,
    /// Multipart-конфиги по leaf_id. None = маршрут не multipart.
    pub multipart: Vec<Option<crate::multipart::MultipartConfig>>,
    /// Протокол/TLS/таймауты.
    pub tuning: Tuning,
    /// Счётчики Prometheus (§11). Arc — задачам чтения тела нужен 'static-клон.
    pub metrics: Arc<Metrics>,
    /// Состояние готовности (§11): shutdown/перегрузка/флаг из JS.
    pub readiness: Readiness,
    /// Ограничитель одновременных запросов (§6c C5). None = без лимита.
    pub overload: Option<Limiter>,
}

/// Auto-билдер (h1 + h2 через ALPN/preface) с настройками таймаутов и h2.
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

/// http1-билдер для plaintext без h2c (h1 only) с read-таймаутом.
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

/// Стадии остановки (§10 + §11). Соединения реагируют только на `CLOSING`.
pub const RUNNING: u8 = 0;
/// Readiness снят, но listener ещё принимает: ждём, пока балансировщик уберёт под.
pub const PRE_SHUTDOWN: u8 = 1;
/// Перестаём принимать и просим соединения закрыться.
pub const CLOSING: u8 = 2;

/// Дождаться стадии `CLOSING` (промежуточный `PRE_SHUTDOWN` игнорируем).
async fn wait_closing(rx: &mut watch::Receiver<u8>) {
    loop {
        if *rx.borrow_and_update() >= CLOSING {
            return;
        }
        if rx.changed().await.is_err() {
            return; // отправитель ушёл — считаем это командой закрыться
        }
    }
}

/// Обслужить соединение до конца, реагируя на idle-таймаут и graceful shutdown.
///
/// - истёк idle → future дропается, сокет закрывается;
/// - пришёл `CLOSING` → `graceful_shutdown()` (для h2 это `GOAWAY`, для h1 — дожать
///   текущий запрос и не брать следующий по keep-alive), затем ждём завершения.
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
            // Нет idle-таймаута → ветка не должна выигрывать гонку никогда.
            None => std::future::pending().await,
        }
    };
    tokio::pin!(idle_wait);

    tokio::select! {
        _ = conn.as_mut() => return,
        _ = &mut idle_wait => return,
        _ = wait_closing(&mut shutdown) => {}
        // Перегрузка: ответ 503 уже формируется, соединение закрываем следом.
        _ = shed.notified() => {}
    }

    // Фаза graceful: просим соединение закрыться и даём ему дожать текущий запрос.
    // Дедлайн общий (его держит accept-цикл), здесь только idle остаётся страховкой.
    conn.as_mut().graceful_shutdown();
    tokio::select! {
        _ = conn => {}
        _ = idle_wait => {}
    }
}

/// Accept-цикл и graceful shutdown (§10).
///
/// По сигналу `shutdown`: перестаём принимать соединения и сразу закрываем listener
/// (порт свободен для нового пода), затем даём открытым соединениям дожать запросы
/// до `shutdown_timeout`. Когда drain закончен (или дедлайн истёк) — сигналим `done`.
pub async fn serve(
    listener: Bound,
    shared: Arc<Shared>,
    shutdown: watch::Receiver<u8>,
    done: Arc<Notify>,
) {
    // Билдеры собираем один раз, шарим в задачи через Arc (serve_connection(&self)).
    let auto_builder = Arc::new(build_auto(&shared.tuning));
    let h1_builder = Arc::new(build_h1(&shared.tuning));

    // Детектор drain'а: каждая задача держит клон отправителя. Когда все соединения
    // завершились, все клоны дропнуты и recv() отдаёт None — счётчики не нужны.
    let (drain_tx, mut drain_rx) = mpsc::channel::<()>(1);
    let mut shutdown_acc = shutdown.clone();
    // Живые соединения — для maxConnections (§6c B9).
    let live = Arc::new(AtomicUsize::new(0));

    loop {
        // accept для обоих типов сокета: Unix-пир анонимен, адрес берём условный.
        // PRE_SHUTDOWN не прерывает приём: в этом окне readiness уже снят, но под
        // ещё обслуживает трафик, который балансировщик не успел перенаправить.
        let accepted = tokio::select! {
            _ = wait_closing(&mut shutdown_acc) => break,
            a = accept_any(&listener) => a,
        };
        let (stream, peer_ip) = match accepted {
            Some(v) => v,
            None => continue, // временная ошибка accept — пропускаем
        };

        // Лимит соединений: сверх него сразу закрываем, не тратя задачу и память.
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

    // Listener закрываем немедленно: порт освобождается до окончания drain'а,
    // чтобы сменщик (новый под) мог забиндиться, пока мы дожимаем старые запросы.
    drop(listener);

    // Ждём, пока задачи соединений отпустят свои клоны drain_tx — но не дольше дедлайна.
    drop(drain_tx);
    let deadline = shared.tuning.shutdown_timeout;
    tokio::select! {
        _ = drain_rx.recv() => {}
        _ = tokio::time::sleep(deadline) => {}
    }
    done.notify_one();
}

/// Принятое соединение: TCP либо Unix.
enum AnyStream {
    Tcp(tokio::net::TcpStream),
    Unix(tokio::net::UnixStream),
}

/// Общий accept для обоих типов слушателя. `None` — временная ошибка.
async fn accept_any(listener: &Bound) -> Option<(AnyStream, String)> {
    match listener {
        Bound::Tcp(l) => match l.accept().await {
            Ok((s, peer)) => Some((AnyStream::Tcp(s), peer.ip().to_string())),
            Err(_) => None,
        },
        Bound::Unix(l) => match l.accept().await {
            // У Unix-сокета нет адреса пира: отдаём loopback, чтобы `c.req.ip`
            // оставался непустым (инвариант §7), а реальный источник придёт
            // из customIpHeaders — за unix-сокетом всегда стоит локальный прокси.
            Ok((s, _)) => Some((AnyStream::Unix(s), "127.0.0.1".to_string())),
            Err(_) => None,
        },
    }
}

/// Всё, что задаче соединения нужно от сервера (чтобы не тащить 6 аргументов).
struct ConnCtx {
    shared: Arc<Shared>,
    auto_builder: Arc<auto::Builder<TokioExecutor>>,
    h1_builder: Arc<http1::Builder>,
    shutdown: watch::Receiver<u8>,
    live: Arc<AtomicUsize>,
}

/// Обслужить одно соединение: PROXY-префикс → TLS/ALPN → h1/h2 → drain.
async fn serve_conn<S>(stream: S, peer_ip: String, ctx: ConnCtx)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // Счётчик живых соединений отпускаем в любом случае (в т.ч. при раннем return).
    let _live = LiveGuard(ctx.live);
    let shared = ctx.shared;
    shared.metrics.conn_opened();
    let _conn_metric = ConnMetricGuard(shared.clone());
    let tuning = &shared.tuning;

    // PROXY protocol (§6c A4) — строго до TLS: префикс идёт «сырым» перед хендшейком.
    let (stream, peer_ip) = if tuning.proxy_protocol {
        match proxy_protocol::read_header(stream).await {
            Ok((io, addr)) => (io, addr.unwrap_or(peer_ip)),
            // Префикса нет или он битый — соединение не от нашего балансировщика.
            Err(()) => return,
        }
    } else {
        (proxy_protocol::PrefixedIo::new(stream, Vec::new()), peer_ip)
    };

    // Трекер активности вешаем до TLS: хендшейк тоже считается активностью,
    // а idle одинаково работает для h1/h2/TLS.
    let activity = Activity::new();
    let svc_activity = activity.clone();
    let svc_shared = shared.clone();
    // Сигнал «закрыть это соединение»: его шлёт обработчик при перегрузке,
    // а ловит `drive` — там же, где обрабатывается общий shutdown (§6c C5).
    let shed = Arc::new(Notify::new());
    let svc_shed = shed.clone();
    let service = service_fn(move |req: Request<Incoming>| {
        let shared = svc_shared.clone();
        let peer_ip = peer_ip.clone();
        let shed = svc_shed.clone();
        // Guard держит соединение «занятым», пока считает хендлер:
        // долгая обработка не должна выглядеть как простой.
        let guard = svc_activity.request_guard();
        async move {
            let res = handle(req, shared, peer_ip, shed).await;
            drop(guard);
            Ok::<_, Infallible>(res)
        }
    });

    let idle = tuning.idle_timeout.map(|d| (activity.clone(), d));
    let stream = ActivityIo::new(stream, activity);

    // Ошибки соединения глотаем: процесс не должен падать.
    if let Some(acceptor) = tuning.tls.clone() {
        // TLS: хендшейк с таймаутом → ALPN решает h2/h1.1.
        if let Ok(Ok(tls_stream)) =
            tokio::time::timeout(tuning.handshake_timeout, acceptor.accept(stream)).await
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
        // plaintext, только HTTP/1.1.
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

/// Уменьшает счётчик живых соединений на Drop (в т.ч. при панике задачи).
struct LiveGuard(Arc<AtomicUsize>);

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Снимает соединение с гейджа метрик на Drop.
struct ConnMetricGuard(Arc<Shared>);

impl Drop for ConnMetricGuard {
    fn drop(&mut self) {
        self.0.metrics.conn_closed();
    }
}

/// Отдельный порт для проб и метрик (§11): только h1, только admin-пути.
///
/// Смысл разделения — не светить `/metrics` наружу: основной порт публикуется через
/// Service/Ingress, admin-порт остаётся внутри кластера для Prometheus и kubelet.
pub async fn serve_admin(
    listener: tokio::net::TcpListener,
    shared: Arc<Shared>,
    mut shutdown: watch::Receiver<u8>,
) {
    let builder = Arc::new(http1::Builder::new());
    loop {
        let accepted = tokio::select! {
            _ = wait_closing(&mut shutdown) => break,
            a = listener.accept() => a,
        };
        let Ok((stream, _)) = accepted else { continue };
        let shared = shared.clone();
        let builder = builder.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let shared = shared.clone();
                async move {
                    let method = req.method().as_str().to_uppercase();
                    let res = admin_response(&shared, &method, req.uri().path())
                        .unwrap_or_else(|| status_text(404, "Not Found"));
                    Ok::<_, Infallible>(res)
                }
            });
            let _ = builder
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

/// Прогнать запрос через весь конвейер **без сокета** (§17, `app.inject`).
///
/// Соединение — `tokio::io::duplex`, память вместо сети. Это не мок: работают тот же
/// `handle`, роутинг, схемы, CORS, метрики и JS-луковица, просто байты не выходят за
/// пределы процесса. Возвращает статус, заголовки и тело ответа.
pub async fn inject(
    shared: Arc<Shared>,
    req: Request<Full<Bytes>>,
) -> Result<(u16, Vec<KvPair>, Bytes), String> {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);

    // Серверная сторона канала: тот же путь, что и у реального соединения.
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

/// Общие для запроса данные (вычислены один раз, затем перемещаются в диспетч).
struct ReqData {
    method: String,
    path: String,
    query_string: Option<String>,
    query: Vec<KvPair>,
    headers: Vec<KvPair>,
}

/// Один запрос. Края в Rust (CORS preflight, body-limit) → роутинг/диспетч →
/// навешивание CORS-заголовков на итоговый ответ.
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

    // Пробы и метрики (§11) — до лимитера: под перегрузкой `/readyz` обязан
    // отвечать, иначе k8s не узнает, что под пора снимать с эндпоинтов.
    let probe = if shared.tuning.admin_port.is_none() {
        admin_response(&shared, &method_for_metrics, req.uri().path())
    } else {
        None
    };

    let response = match (probe, &shared.overload) {
        (Some(res), _) => res,
        // Лимит одновременных запросов (§6c C5). Permit держим на всё время
        // обработки; сверх лимита и очереди — 503 + Retry-After.
        (None, Some(limiter)) => match limiter.acquire().await {
            Slot::Acquired(permit) => {
                // Слот нашёлся → полоса перегрузки кончилась, readiness возвращаем.
                shared.readiness.set_overloaded(false);
                let res = handle_inner(req, &shared, peer_ip).await;
                drop(permit);
                res
            }
            Slot::Rejected { retry_after } => {
                // Устойчивая перегрузка → снимаем readiness (слой 2, §6c C5).
                shared.readiness.set_overloaded(limiter.should_shed());
                // Просим соединение закрыться: для h2 это GOAWAY — клиент
                // переоткроется, возможно уже на другой под. Для h1 — закрытие
                // keep-alive после ответа, с тем же эффектом.
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

/// Ответ при перегрузке (§6c C5): 503 + Retry-After, чтобы retry-способный
/// ingress/mesh увёл запрос на другую реплику, а клиент знал, когда повторять.
fn overloaded_response(retry_after: u64) -> Response<ResBody> {
    builder_or_500(
        Response::builder()
            .status(503)
            .header("retry-after", retry_after.to_string())
            .header("content-type", "text/plain; charset=utf-8"),
        full("Service Unavailable"),
    )
}

/// Пробы и метрики (§11). `None` — путь не наш, обрабатываем как обычный запрос.
///
/// Отвечаем целиком в Rust: k8s дёргает пробы раз в секунду, будить ради этого JS
/// незачем. `/readyz` отдаёт 503 при drain'е/перегрузке — k8s снимает под с эндпоинтов.
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

/// Строка access-log в stdout: одна JSON-строка на запрос (§11).
///
/// Пишем из Rust, чтобы не будить JS ради лога. Поля вручную, без serde:
/// экранировать нужно только путь (метод и числа безопасны по построению).
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

/// Минимальное экранирование строки для JSON-лога.
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

/// Тело обработки запроса (без метрик/лога — их навешивает `handle`).
async fn handle_inner(
    req: Request<Incoming>,
    shared: &Arc<Shared>,
    peer_ip: String,
) -> Response<ResBody> {
    let (parts, incoming) = req.into_parts();
    let method = parts.method.as_str().to_uppercase();
    let origin = header_str(&parts.headers, "origin");

    // CORS preflight на краю: OPTIONS + Access-Control-Request-Method →
    // отвечаем в Rust, НЕ будя JS (§6a). Запрещённый origin → 403.
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

    // Ранний отказ: заявленный Content-Length уже больше лимита → 413 сразу,
    // не читая тело (защита от DoS до пробуждения JS). Авторитетная проверка —
    // по фактическим байтам в read_body_task (Content-Length может лгать/отсутствовать).
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

/// Роутинг + диспетч в JS (без CORS — им оборачивает `handle`).
async fn route_and_dispatch(
    shared: &Arc<Shared>,
    peer_ip: &str,
    data: ReqData,
    incoming: Incoming,
    has_body: bool,
) -> Response<ResBody> {
    // 1. Прямой матч (метод-специфичное дерево или ALL).
    if let Some(m) = shared.routes.match_route(&data.method, &data.path) {
        return dispatch(
            shared, peer_ip, m.leaf_id, data, m.params, false, incoming, has_body,
        )
        .await;
    }

    // 2. Авто-HEAD: нет HEAD-маршрута → пробуем GET, тело обрежем.
    if data.method == "HEAD" {
        if let Some(m) = shared.routes.match_route("GET", &data.path) {
            return dispatch(
                shared, peer_ip, m.leaf_id, data, m.params, true, incoming, has_body,
            )
            .await;
        }
    }

    // 3. Путь не сматчен под этим методом. 404 vs 405 vs авто-OPTIONS.
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

/// Навесить CORS-заголовки обычного ответа (если origin разрешён).
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

/// Значение заголовка как строка (первый, если несколько).
fn header_str(headers: &hyper::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Ответ из статуса + пар заголовков (для CORS preflight).
fn pairs_response(status: u16, headers: Vec<(String, String)>) -> Response<ResBody> {
    let mut builder = Response::builder().status(status);
    for (k, v) in headers {
        builder = builder.header(k, v);
    }
    builder_or_500(builder, empty())
}

/// Позвать JS-диспетчер, дождаться `Promise`, собрать HTTP-ответ.
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

    // Схема этого листа (notFound / без схемы → None).
    let schema = if leaf_id >= 0 {
        shared
            .schemas
            .get(leaf_id as usize)
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    // Multipart-конфиг этого листа.
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

    // Multipart-маршрут: проверяем Content-Type → 415, извлекаем boundary → парсим потоково.
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

    // Тело буферизуем в Rust только для нативной валидации несжатого тела (не multipart).
    let compressed = is_compressed(&data.headers);
    let buffer_for_schema =
        multipart_cfg.is_none() && schema.is_some_and(|s| s.has_body()) && has_body && !compressed;

    let mut buffered: Option<Bytes> = None;
    if buffer_for_schema {
        match buffer_body(
            incoming.take().unwrap(),
            shared.body_limit,
            shared.tuning.body_read_timeout,
        )
        .await
        {
            Ok(b) => buffered = Some(b),
            Err(BodyErr::TooLarge) => return status_text(413, "Payload Too Large"),
            Err(BodyErr::Timeout) => return status_text(408, "Request Timeout"),
        }
    }

    // Структурная валидация в Rust → 400 без пробуждения JS (§6b). Body — только не-multipart.
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

    // Канал тела запроса. Буферизованное отдаём одним чанком; multipart → обычного тела нет.
    let req_rx = if multipart_cfg.is_some() {
        None
    } else if let Some(b) = buffered {
        let (tx, rx) = mpsc::channel::<BodyMsg>(1);
        let _ = tx.try_send(BodyMsg::Data(b)); // помещается (cap 1), затем закрываем
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

    // Канал тела ответа (используется, если хендлер стримит).
    let (resp_tx, resp_rx) = mpsc::channel::<Bytes>(BODY_CHANNEL_CAP);
    let body_io = BodyIo::new(req_rx, Some(resp_tx), mp_rx);

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
        valid_body: validated.body,
        valid_query: validated.query,
        valid_params: validated.params,
    };

    match shared.tsfn.call_async((req, body_io)).await {
        Ok(promise) => match promise.await {
            Ok(res) => build_response(res, head, resp_rx, &shared.metrics),
            Err(_) => status_text(500, "Internal Server Error"),
        },
        Err(_) => status_text(500, "Internal Server Error"),
    }
}

/// Фоновая задача: читает тело запроса по фреймам → канал (backpressure через cap).
///
/// Авторитетный body-limit: считаем **фактические** байты (не доверяя Content-Length).
/// При превышении шлём `Overflow` и прекращаем читать сокет — обойти из JS нельзя.
async fn read_body_task(
    mut body: Incoming,
    tx: Sender<BodyMsg>,
    limit: Option<u64>,
    read_timeout: Option<Duration>,
    metrics: Arc<Metrics>,
) {
    let mut total: u64 = 0;
    loop {
        // Таймаут считаем на ожидание чанка, а не на всё тело: медленный, но
        // живой аплоад проходит, а Slowloris с телом — обрывается (§6c A2).
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
        let Some(Ok(frame)) = next else { break };
        if let Ok(data) = frame.into_data() {
            total = total.saturating_add(data.len() as u64);
            metrics.add_request_bytes(data.len() as u64);
            if limit.is_some_and(|lim| total > lim) {
                let _ = tx.send(BodyMsg::Overflow).await;
                return; // прекращаем читать тело (защита от DoS)
            }
            if tx.send(BodyMsg::Data(data)).await.is_err() {
                break; // получатель ушёл (JS перестал читать)
            }
        }
    }
}

/// Значение Content-Length, если валидно.
fn content_length(headers: &hyper::HeaderMap) -> Option<u64> {
    headers
        .get(hyper::header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()
}

/// Почему не удалось вычитать тело: превышен лимит (413) или молчание клиента (408).
enum BodyErr {
    TooLarge,
    Timeout,
}

/// Буферизовать тело целиком (для нативной валидации), соблюдая лимит и read-таймаут.
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
        let Some(Ok(frame)) = next else { break };
        if let Ok(data) = frame.into_data() {
            if limit.is_some_and(|l| buf.len() as u64 + data.len() as u64 > l) {
                return Err(BodyErr::TooLarge);
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(buf.freeze())
}

/// Сжато ли тело (Content-Encoding не identity).
fn is_compressed(headers: &[KvPair]) -> bool {
    headers.iter().any(|kv| {
        kv.key == "content-encoding" && {
            let v = kv.value.trim().to_lowercase();
            !v.is_empty() && v != "identity"
        }
    })
}

/// Ответ `400` со списком ошибок валидации (машиночитаемый, без пробуждения JS).
fn validation_response(issues: &[crate::schema::Issue]) -> Response<ResBody> {
    let body = crate::schema::errors_body(issues);
    builder_or_500(
        Response::builder()
            .status(400)
            .header("content-type", "application/json; charset=utf-8"),
        Full::new(Bytes::from(body)).boxed(),
    )
}

/// Есть ли у запроса тело (content-length>0 или transfer-encoding).
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
            key: k.as_str().to_string(), // http::HeaderName уже lowercase
            value: v.to_str().unwrap_or("").to_string(),
        })
        .collect()
}

/// `ip`/`ips`/`country` по §7: первый заполненный из custom-заголовков, XFF по запятым.
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

/// request-id из заголовка либо новый UUIDv7 (§6d B2).
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
            // .header() добавляет (append) — несколько set-cookie сохраняются.
            builder = builder.header(kv.key, kv.value);
        }
    }

    let streamed = res.streamed.unwrap_or(false);

    // HEAD: тело не отправляем, но сохраняем content-length от строкового тела.
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

/// Тело из владеемой строки (метрики собираются на лету, статикой не обойтись).
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

/// Собрать ответ из builder+body; при ошибке (невалидный заголовок) — 500.
fn builder_or_500(builder: hyper::http::response::Builder, body: ResBody) -> Response<ResBody> {
    builder
        .body(body)
        .unwrap_or_else(|_| status_text(500, "Internal Server Error"))
}
