#![deny(clippy::all)]

//! `@oxide/http` — нативный аддон (napi-rs). Публичный JS-API живёт в обёртке
//! `js/index.js`; здесь — низкоуровневый `RustServer`. См. DESIGN.md / IMPLEMENTATION.md.

mod bridge;
mod cors;
mod multipart;
mod router;
mod schema;
mod server;
mod stream;

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{Function, Promise};
use napi::Result;
use napi_derive::napi;
use tokio::runtime::Runtime;
use tokio::sync::Notify;

use crate::bridge::{Handler, JsResponse, MatchedRequest};
use crate::cors::{Cors, CorsOptions as RCorsOptions};
use crate::router::{RouteDef as RRouteDef, Routes};
use crate::server::{serve, Shared};
use crate::stream::BodyIo;

/// Опции CORS с JS-стороны (нормализованы обёрткой). Отсутствие = CORS выключен.
#[napi(object)]
pub struct CorsOptions {
    pub origins: Vec<String>,
    pub methods: Vec<String>,
    pub allowed_headers: Option<Vec<String>>,
    pub exposed_headers: Option<Vec<String>>,
    pub credentials: bool,
    pub max_age: Option<i64>,
}

/// Определение маршрута из JS-обёртки (path уже склеен с baseUrl/групповым префиксом).
/// Схемы — JSON Schema как строки (обёртка конвертирует valibot заранее).
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

/// Per-route опции multipart (нормализованы обёрткой; лимиты в байтах/штуках).
#[napi(object)]
pub struct MultipartOptions {
    pub max_file_size: Option<i64>,
    pub max_field_size: Option<i64>,
    pub max_files: Option<i64>,
    pub max_fields: Option<i64>,
    pub allowed_mime_types: Option<Vec<String>>,
    pub allowed_extensions: Option<Vec<String>>,
}

/// Опции сервера, влияющие на вычисление контекста в Rust (§4, §7, §6d).
#[napi(object)]
pub struct ListenOptions {
    pub custom_ip_headers: Option<Vec<String>>,
    pub custom_country_headers: Option<Vec<String>>,
    pub request_id_header: Option<String>,
    /// Жёсткий лимит тела запроса в байтах (авторитетно в Rust). null/отсутствие = без лимита.
    pub body_limit: Option<i64>,
    /// Нативный CORS. null/отсутствие = выключен.
    pub cors: Option<CorsOptions>,
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
        // Компилируем деревья + схемы ДО bind: конфликты/невалидные паттерны/схемы → ранняя ошибка.
        let n = routes.len();
        let mut route_defs = Vec::with_capacity(n);
        let mut schema_slots: Vec<Option<crate::schema::LeafSchema>> =
            (0..n).map(|_| None).collect();
        let mut mp_slots: Vec<Option<crate::multipart::MultipartConfig>> =
            (0..n).map(|_| None).collect();
        for r in routes {
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

/// napi MultipartOptions → внутренний MultipartConfig (лимиты i64 → u64/u32).
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
