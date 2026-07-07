//! Мост Rust↔JS: типы, пересекающие границу, и ThreadsafeFunction-хендлер.
//!
//! На M2 в JS уходит уже сматченный запрос (`leaf_id` листа, `params`, `query`),
//! обратно — `{ status?, headers?, body? }`.
//! Полный контекст `c` (заголовки, ip, хелперы) появится на M3.

use std::collections::HashMap;

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;
use napi_derive::napi;

/// Пара ключ-значение (для query, где ключи могут повторяться).
#[napi(object)]
pub struct KvPair {
    pub key: String,
    pub value: String,
}

/// Сматченный запрос, передаваемый в JS-диспетчер (один переход границы/запрос).
///
/// `leaf_id` — индекс листа маршрута в JS-реестре хендлеров; `-1` = notFound.
/// `path` — полный путь (с baseUrl); обёртка снимает префикс для `c.req.path`.
/// `ip`/`ips`/`country`/`id` вычислены в Rust (§7, §6d B2).
#[napi(object)]
pub struct MatchedRequest {
    pub leaf_id: i32,
    pub method: String,
    pub path: String,
    pub query_string: Option<String>,
    pub params: HashMap<String, String>,
    pub query: Vec<KvPair>,
    pub headers: Vec<KvPair>,
    pub ip: String,
    pub ips: Vec<String>,
    pub country: Option<String>,
    pub id: String,
}

/// Ответ, который JS-хендлер возвращает (в составе `Promise`).
///
/// `headers` — упорядоченные пары с допуском повторов (несколько `set-cookie`).
/// Тело на M3 — строка; `Buffer`/стримы придут на M4.
#[napi(object)]
pub struct JsResponse {
    pub status: Option<u16>,
    pub headers: Option<Vec<KvPair>>,
    pub body: Option<String>,
}

/// TSFN-обёртка над JS-диспетчером: `(req) => Promise<res>`.
///
/// Вызывается из любого tokio-потока; `call_async` возвращает `Promise`,
/// который мы `await`-им как Rust-`Future` (без блокировки потока).
pub type Handler = ThreadsafeFunction<
    MatchedRequest,      // T: данные в call_async
    Promise<JsResponse>, // Return: что возвращает JS (Promise)
    MatchedRequest,      // CallJsBackArgs: аргумент JS-функции
    Status,              // ErrorStatus
    false,               // CalleeHandled: ошибки обрабатываем сами (call_async(value: T))
>;
