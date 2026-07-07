//! tokio + hyper: accept-цикл и обслуживание запроса (HTTP/1.1).
//!
//! На M3: собираем заголовки запроса (lowercase), вычисляем `ip/ips/country`
//! (§7) и request-id (§6d B2) в Rust, передаём в JS-контекст одним переходом.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::bridge::{Handler, JsResponse, KvPair, MatchedRequest};
use crate::router::Routes;

/// Общее состояние, разделяемое между соединениями.
pub struct Shared {
    pub tsfn: Handler,
    pub routes: Routes,
    pub has_not_found: bool,
    pub custom_ip_headers: Vec<String>,
    pub custom_country_headers: Vec<String>,
    pub request_id_header: String,
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

/// Один запрос: роутинг в Rust → (JS-диспетчер | статический ответ Rust).
async fn handle(
    req: Request<Incoming>,
    shared: Arc<Shared>,
    peer_ip: String,
) -> Response<Full<Bytes>> {
    let method = req.method().as_str().to_uppercase();
    let path = req.uri().path().to_string();
    let query_string = req.uri().query().map(|s| s.to_string());
    let data = ReqData {
        query: parse_query(query_string.as_deref()),
        headers: collect_headers(&req),
        method,
        path,
        query_string,
    };

    // 1. Прямой матч (метод-специфичное дерево или ALL).
    if let Some(m) = shared.routes.match_route(&data.method, &data.path) {
        return dispatch(&shared, &peer_ip, m.leaf_id, data, m.params, false).await;
    }

    // 2. Авто-HEAD: нет HEAD-маршрута → пробуем GET, тело обрежем.
    if data.method == "HEAD" {
        if let Some(m) = shared.routes.match_route("GET", &data.path) {
            return dispatch(&shared, &peer_ip, m.leaf_id, data, m.params, true).await;
        }
    }

    // 3. Путь не сматчен под этим методом. 404 vs 405 vs авто-OPTIONS.
    let allowed = shared.routes.allowed_methods(&data.path);

    if allowed.is_empty() {
        // 404 — либо notFound в JS, либо статический ответ Rust.
        if shared.has_not_found {
            return dispatch(&shared, &peer_ip, -1, data, HashMap::new(), false).await;
        }
        return status_text(404, "Not Found");
    }

    let allow = allowed.join(", ");

    if data.method == "OPTIONS" {
        // авто-OPTIONS: 204 + Allow (JS не будим).
        return Response::builder()
            .status(204)
            .header("allow", allow)
            .body(Full::new(Bytes::new()))
            .unwrap_or_else(|_| status_text(500, "Internal Server Error"));
    }

    // 405 Method Not Allowed + Allow.
    Response::builder()
        .status(405)
        .header("allow", allow)
        .body(Full::new(Bytes::from_static(b"Method Not Allowed")))
        .unwrap_or_else(|_| status_text(500, "Internal Server Error"))
}

/// Позвать JS-диспетчер, дождаться `Promise`, собрать HTTP-ответ.
async fn dispatch(
    shared: &Shared,
    peer_ip: &str,
    leaf_id: i32,
    data: ReqData,
    params: HashMap<String, String>,
    head: bool,
) -> Response<Full<Bytes>> {
    let (ip, ips, country) = client_ip_country(
        &data.headers,
        &shared.custom_ip_headers,
        &shared.custom_country_headers,
        peer_ip,
    );
    let id = request_id(&data.headers, &shared.request_id_header);

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
    };

    match shared.tsfn.call_async(req).await {
        Ok(promise) => match promise.await {
            Ok(res) => build_response(res, head),
            Err(_) => status_text(500, "Internal Server Error"),
        },
        Err(_) => status_text(500, "Internal Server Error"),
    }
}

/// Заголовки запроса → пары (имя lowercase). Непечатные значения → "".
fn collect_headers(req: &Request<Incoming>) -> Vec<KvPair> {
    req.headers()
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

fn build_response(res: JsResponse, head: bool) -> Response<Full<Bytes>> {
    let mut builder = Response::builder().status(res.status.unwrap_or(200));
    if let Some(headers) = res.headers {
        for kv in headers {
            // .header() добавляет (append) — несколько set-cookie сохраняются.
            builder = builder.header(kv.key, kv.value);
        }
    }

    let body_bytes = Bytes::from(res.body.unwrap_or_default());

    // HEAD: тело не отправляем, но сохраняем content-length от GET-хендлера.
    if head {
        if let Some(headers) = builder.headers_mut() {
            if !headers.contains_key("content-length") {
                if let Ok(v) = body_bytes.len().to_string().parse() {
                    headers.insert("content-length", v);
                }
            }
        }
        return builder
            .body(Full::new(Bytes::new()))
            .unwrap_or_else(|_| status_text(500, "Internal Server Error"));
    }

    builder
        .body(Full::new(body_bytes))
        .unwrap_or_else(|_| status_text(500, "Internal Server Error"))
}

fn status_text(code: u16, text: &'static str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(code)
        .body(Full::new(Bytes::from_static(text.as_bytes())))
        .expect("static response is always valid")
}
