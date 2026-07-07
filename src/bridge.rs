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
#[napi(object)]
pub struct MatchedRequest {
    pub leaf_id: i32,
    pub method: String,
    pub path: String,
    pub params: HashMap<String, String>,
    pub query: Vec<KvPair>,
}

/// Ответ, который JS-хендлер возвращает (в составе `Promise`).
#[napi(object)]
pub struct JsResponse {
    pub status: Option<u16>,
    pub headers: Option<HashMap<String, String>>,
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
