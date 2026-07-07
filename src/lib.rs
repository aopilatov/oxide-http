#![deny(clippy::all)]

//! `@oxide/http` — нативный аддон (napi-rs). Публичный JS-API живёт в обёртке
//! `js/index.js`; здесь — низкоуровневый `RustServer`. См. DESIGN.md / IMPLEMENTATION.md.

mod bridge;
mod router;
mod server;
mod stream;

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{Function, Promise};
use napi::Result;
use napi_derive::napi;
use tokio::runtime::Runtime;
use tokio::sync::Notify;

use crate::bridge::{Handler, JsResponse, MatchedRequest};
use crate::router::{RouteDef as RRouteDef, Routes};
use crate::server::{serve, Shared};
use crate::stream::BodyIo;

/// Определение маршрута из JS-обёртки (path уже склеен с baseUrl/групповым префиксом).
#[napi(object)]
pub struct RouteDef {
    pub method: String,
    pub path: String,
    pub leaf_id: i32,
}

/// Опции сервера, влияющие на вычисление контекста в Rust (§4, §7, §6d).
#[napi(object)]
pub struct ListenOptions {
    pub custom_ip_headers: Option<Vec<String>>,
    pub custom_country_headers: Option<Vec<String>>,
    pub request_id_header: Option<String>,
}

/// Состояние запущенного сервера (живёт, пока сервер слушает).
struct Running {
    runtime: Runtime,
    shutdown: Arc<Notify>,
}

/// Низкоуровневый сервер. Оборачивается JS-классом `Server`.
#[napi]
pub struct RustServer {
    state: Mutex<Option<Running>>,
}

#[napi]
impl RustServer {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)] // конструктор экспортируется в JS
    pub fn new() -> Self {
        RustServer {
            state: Mutex::new(None),
        }
    }

    /// Поднять HTTP/1.1 на `host:port` с таблицей маршрутов.
    ///
    /// Роутинг/`404`/`405`/авто-`OPTIONS` — в Rust; попадание в лист зовёт
    /// `dispatch(req) => Promise<res>`. Неблокирующий (accept-цикл в фоне).
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
        // Компилируем деревья ДО bind: конфликты/невалидные паттерны → ранняя ошибка.
        let route_defs = routes
            .into_iter()
            .map(|r| RRouteDef {
                method: r.method,
                path: r.path,
                leaf_id: r.leaf_id,
            })
            .collect();
        let routes = Routes::build(route_defs).map_err(napi::Error::from_reason)?;

        // TSFN строим синхронно, пока JS-функция жива; дальше она 'static + Send.
        let tsfn: Handler = dispatch.build_threadsafe_function().build()?;

        // Слушаем сокет синхронно → ошибки bind (EADDRINUSE и т.п.) отдаём сразу.
        let std_listener = std::net::TcpListener::bind((host.as_str(), port))
            .map_err(|e| napi::Error::from_reason(format!("bind {host}:{port}: {e}")))?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;

        let shared = Arc::new(Shared {
            tsfn,
            routes,
            has_not_found,
            custom_ip_headers: options.custom_ip_headers.unwrap_or_default(),
            custom_country_headers: options.custom_country_headers.unwrap_or_default(),
            request_id_header: options
                .request_id_header
                .unwrap_or_else(|| "x-request-id".to_string()),
        });
        let shutdown = Arc::new(Notify::new());
        let sd = shutdown.clone();
        runtime.spawn(async move {
            serve(std_listener, shared, sd).await;
        });

        *self.state.lock().unwrap() = Some(Running { runtime, shutdown });
        Ok(())
    }

    /// Остановить сервер: разбудить accept-цикл и завершить рантайм в фоне
    /// (не блокируя JS-поток). Идемпотентно.
    #[napi]
    pub fn close(&self) -> Result<()> {
        if let Some(running) = self.state.lock().unwrap().take() {
            running.shutdown.notify_waiters();
            running.runtime.shutdown_background();
        }
        Ok(())
    }
}
