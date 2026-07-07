#![deny(clippy::all)]

//! `@oxide/http` — нативный аддон (napi-rs). См. DESIGN.md / IMPLEMENTATION.md.

mod bridge;
mod server;

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::Function;
use napi::Result;
use napi_derive::napi;
use tokio::runtime::Runtime;
use tokio::sync::Notify;

use crate::bridge::{Handler, JsRequest, JsResponse};

/// Состояние запущенного сервера (живёт, пока сервер слушает).
struct Running {
    runtime: Runtime,
    shutdown: Arc<Notify>,
}

/// Публичный класс сервера. На M1 — минимальный: `listen(port, handler)` / `close()`.
#[napi]
pub struct Server {
    state: Mutex<Option<Running>>,
}

#[napi]
impl Server {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)] // конструктор экспортируется в JS
    pub fn new() -> Self {
        Server {
            state: Mutex::new(None),
        }
    }

    /// Поднять HTTP/1.1 на `port`. Каждый запрос уходит в `handler`.
    ///
    /// Неблокирующий: собственный tokio-рантайм крутит accept-цикл в фоне,
    /// JS event loop свободен. `handler: (req) => Promise<res>`.
    #[napi]
    pub fn listen(
        &self,
        port: u16,
        handler: Function<JsRequest, napi::bindgen_prelude::Promise<JsResponse>>,
    ) -> Result<()> {
        // TSFN строим синхронно, пока JS-функция жива; дальше она 'static + Send.
        let tsfn: Handler = handler.build_threadsafe_function().build()?;
        let tsfn = Arc::new(tsfn);

        // Слушаем сокет синхронно → ошибки bind (EADDRINUSE и т.п.) отдаём сразу.
        let std_listener = std::net::TcpListener::bind(("0.0.0.0", port))
            .map_err(|e| napi::Error::from_reason(format!("bind {port}: {e}")))?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;

        let shutdown = Arc::new(Notify::new());
        let sd = shutdown.clone();
        runtime.spawn(async move {
            server::serve(std_listener, tsfn, sd).await;
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
