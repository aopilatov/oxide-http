//! tokio + hyper: accept-цикл и обслуживание запроса (HTTP/1.1).
//!
//! На M2 добавлен роутинг: сматчиваем метод+путь в Rust, `404/405`/авто-`OPTIONS`
//! отдаём без пробуждения JS; при попадании в лист — зовём JS-диспетчер.

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
                let stream = match accepted {
                    Ok((stream, _peer)) => stream,
                    Err(_) => continue, // временная ошибка accept — пропускаем
                };
                let io = TokioIo::new(stream);
                let shared = shared.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let shared = shared.clone();
                        async move { Ok::<_, Infallible>(handle(req, shared).await) }
                    });
                    // Ошибку соединения глотаем: процесс не должен падать.
                    let _ = http1::Builder::new().serve_connection(io, service).await;
                });
            }
        }
    }
}

/// Один запрос: роутинг в Rust → (JS-диспетчер | статический ответ Rust).
async fn handle(req: Request<Incoming>, shared: Arc<Shared>) -> Response<Full<Bytes>> {
    let method = req.method().as_str().to_uppercase();
    let path = req.uri().path().to_string();
    let query = parse_query(req.uri().query());

    // 1. Прямой матч (метод-специфичное дерево или ALL).
    if let Some(m) = shared.routes.match_route(&method, &path) {
        return dispatch(&shared, m.leaf_id, &method, path, m.params, query, false).await;
    }

    // 2. Авто-HEAD: нет HEAD-маршрута → пробуем GET, тело обрежем.
    if method == "HEAD" {
        if let Some(m) = shared.routes.match_route("GET", &path) {
            return dispatch(&shared, m.leaf_id, &method, path, m.params, query, true).await;
        }
    }

    // 3. Путь не сматчен под этим методом. 404 vs 405 vs авто-OPTIONS.
    let allowed = shared.routes.allowed_methods(&path);

    if allowed.is_empty() {
        // 404 — либо notFound в JS, либо статический ответ Rust.
        if shared.has_not_found {
            return dispatch(&shared, -1, &method, path, Default::default(), query, false).await;
        }
        return status_text(404, "Not Found");
    }

    let allow = allowed.join(", ");

    if method == "OPTIONS" {
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
#[allow(clippy::too_many_arguments)]
async fn dispatch(
    shared: &Shared,
    leaf_id: i32,
    method: &str,
    path: String,
    params: std::collections::HashMap<String, String>,
    query: Vec<KvPair>,
    head: bool,
) -> Response<Full<Bytes>> {
    let req = MatchedRequest {
        leaf_id,
        method: method.to_string(),
        path,
        params,
        query,
    };
    match shared.tsfn.call_async(req).await {
        Ok(promise) => match promise.await {
            Ok(res) => build_response(res, head),
            Err(_) => status_text(500, "Internal Server Error"),
        },
        Err(_) => status_text(500, "Internal Server Error"),
    }
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
        for (k, v) in headers {
            builder = builder.header(k, v);
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
