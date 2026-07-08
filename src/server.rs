//! tokio + hyper: accept-цикл и обслуживание запроса (HTTP/1.1).
//!
//! Края в Rust (§6a): CORS preflight и body-limit обрываются до пробуждения JS.
//! Тело запроса читается в канал (backpressure JS→Rust), тело ответа может
//! стримиться через канальный `Body` (backpressure Rust→JS). См. stream.rs / cors.rs.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::mpsc::{self, Receiver, Sender};
use tokio::sync::Notify;

use crate::bridge::{Handler, JsResponse, KvPair, MatchedRequest};
use crate::cors::Cors;
use crate::router::Routes;
use crate::stream::{BodyIo, BodyMsg, ChannelBody, BODY_CHANNEL_CAP};

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
}

/// Accept-цикл. Останавливается по `shutdown` либо при drop'е рантайма.
pub async fn serve(
    std_listener: std::net::TcpListener,
    shared: Arc<Shared>,
    shutdown: Arc<Notify>,
) {
    let listener = match TcpListener::from_std(std_listener) {
        Ok(l) => l,
        Err(_) => return,
    };

    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(v) => v,
                    Err(_) => continue, // временная ошибка accept — пропускаем
                };
                let peer_ip = peer.ip().to_string();
                let io = TokioIo::new(stream);
                let shared = shared.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let shared = shared.clone();
                        let peer_ip = peer_ip.clone();
                        async move { Ok::<_, Infallible>(handle(req, shared, peer_ip).await) }
                    });
                    // Ошибку соединения глотаем: процесс не должен падать.
                    let _ = http1::Builder::new().serve_connection(io, service).await;
                });
            }
        }
    }
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
async fn handle(req: Request<Incoming>, shared: Arc<Shared>, peer_ip: String) -> Response<ResBody> {
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
                &shared,
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

    let response = route_and_dispatch(&shared, &peer_ip, data, incoming, has_body).await;
    apply_cors(&shared, origin.as_deref(), response)
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
        match buffer_body(incoming.take().unwrap(), shared.body_limit).await {
            Ok(b) => buffered = Some(b),
            Err(()) => return status_text(413, "Payload Too Large"),
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
            Ok(res) => build_response(res, head, resp_rx),
            Err(_) => status_text(500, "Internal Server Error"),
        },
        Err(_) => status_text(500, "Internal Server Error"),
    }
}

/// Фоновая задача: читает тело запроса по фреймам → канал (backpressure через cap).
///
/// Авторитетный body-limit: считаем **фактические** байты (не доверяя Content-Length).
/// При превышении шлём `Overflow` и прекращаем читать сокет — обойти из JS нельзя.
async fn read_body_task(mut body: Incoming, tx: Sender<BodyMsg>, limit: Option<u64>) {
    let mut total: u64 = 0;
    while let Some(Ok(frame)) = body.frame().await {
        if let Ok(data) = frame.into_data() {
            total = total.saturating_add(data.len() as u64);
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

/// Буферизовать тело целиком (для нативной валидации), соблюдая лимит.
/// `Err(())` — превышение лимита.
async fn buffer_body(mut body: Incoming, limit: Option<u64>) -> Result<Bytes, ()> {
    let mut buf = BytesMut::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else { break };
        if let Ok(data) = frame.into_data() {
            if limit.is_some_and(|l| buf.len() as u64 + data.len() as u64 > l) {
                return Err(());
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

fn build_response(res: JsResponse, head: bool, resp_rx: Receiver<Bytes>) -> Response<ResBody> {
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
    builder_or_500(builder, Full::new(bytes).boxed())
}

fn full(text: &'static str) -> ResBody {
    Full::new(Bytes::from_static(text.as_bytes())).boxed()
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
