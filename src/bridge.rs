//! Мост Rust↔JS: типы, пересекающие границу, и ThreadsafeFunction-хендлер.
//!
//! На M1 контракт минимален: в JS уходит `{ method, path }`, обратно —
//! `{ status?, headers?, body? }`. Полный контекст `c` появится на M3.

use std::collections::HashMap;

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;
use napi_derive::napi;

/// Запрос, передаваемый в JS-хендлер (один переход границы на запрос).
#[napi(object)]
pub struct JsRequest {
    pub method: String,
    pub path: String,
}

/// Ответ, который JS-хендлер возвращает (в составе `Promise`).
#[napi(object)]
pub struct JsResponse {
    pub status: Option<u16>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
}

/// TSFN-обёртка над JS-хендлером: `(req) => Promise<res>`.
///
/// Вызывается из любого tokio-потока; `call_async` возвращает `Promise`,
/// который мы `await`-им как Rust-`Future` (без блокировки потока).
pub type Handler = ThreadsafeFunction<
    JsRequest,           // T: данные в call_async
    Promise<JsResponse>, // Return: что возвращает JS (Promise)
    JsRequest,           // CallJsBackArgs: аргумент JS-функции
    Status,              // ErrorStatus
    false,               // CalleeHandled: ошибки обрабатываем сами (call_async(value: T))
>;
