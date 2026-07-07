//! tokio + hyper: accept-цикл и обслуживание одного соединения (HTTP/1.1).
//!
//! M1 — «шагающий скелет»: любой запрос уходит в JS-хендлер, ответ пишется
//! обратно в hyper. Роутинг/TLS/h2 — на следующих milestone'ах.

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

use crate::bridge::{Handler, JsRequest, JsResponse};

/// Accept-цикл. Останавливается по `shutdown` либо при drop'е рантайма.
pub async fn serve(std_listener: std::net::TcpListener, tsfn: Arc<Handler>, shutdown: Arc<Notify>) {
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
                let tsfn = tsfn.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let tsfn = tsfn.clone();
                        async move { Ok::<_, Infallible>(handle(req, tsfn).await) }
                    });
                    // Ошибку соединения глотаем: процесс не должен падать.
                    let _ = http1::Builder::new().serve_connection(io, service).await;
                });
            }
        }
    }
}

/// Один запрос: дёргаем JS-хендлер, ждём его `Promise`, пишем ответ.
async fn handle(req: Request<Incoming>, tsfn: Arc<Handler>) -> Response<Full<Bytes>> {
    let js_req = JsRequest {
        method: req.method().to_string(),
        path: req.uri().path().to_string(),
    };

    match tsfn.call_async(js_req).await {
        Ok(promise) => match promise.await {
            Ok(res) => build_response(res),
            Err(_) => status_500(),
        },
        Err(_) => status_500(),
    }
}

fn build_response(res: JsResponse) -> Response<Full<Bytes>> {
    let mut builder = Response::builder().status(res.status.unwrap_or(200));
    if let Some(headers) = res.headers {
        for (k, v) in headers {
            builder = builder.header(k, v);
        }
    }
    let body = res.body.unwrap_or_default();
    builder
        .body(Full::new(Bytes::from(body)))
        .unwrap_or_else(|_| status_500())
}

fn status_500() -> Response<Full<Bytes>> {
    Response::builder()
        .status(500)
        .body(Full::new(Bytes::from_static(b"Internal Server Error")))
        .expect("static 500 response is always valid")
}
