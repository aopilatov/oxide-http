//! The Rust↔JS bridge: types that cross the boundary and the ThreadsafeFunction handler.
//!
//! JS receives an already matched request (route leaf `leaf_id`, `params`, `query`)
//! and returns `{ status?, headers?, body? }`. The full context `c` (headers, ip,
//! helpers) is assembled on the JS side — see js/context.ts.

use std::collections::HashMap;

use napi::bindgen_prelude::Promise;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;
use napi_derive::napi;

use crate::stream::BodyIo;

/// Key-value pair (for query strings, where keys may repeat).
#[napi(object)]
pub struct KvPair {
    pub key: String,
    pub value: String,
}

/// A matched request handed to the JS dispatcher (one boundary crossing per request).
///
/// `leaf_id` — index of the route leaf in the JS handler registry; `-1` = notFound.
/// `path` — full path (including baseUrl); the wrapper strips the prefix for `c.req.path`.
/// `ip`/`ips`/`country`/`id` are computed in Rust (§7, §6d B2).
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
    /// True when Rust already decompressed the body (it buffered it for schema
    /// validation). JS must then skip its own decoding — the bytes are already plain.
    pub body_decoded: bool,
    /// Validated/coerced values (JSON strings) — present when the leaf has a schema.
    /// `c.req.valid('body'|'query'|'params')` in JS then applies the valibot transform.
    pub valid_body: Option<String>,
    pub valid_query: Option<String>,
    pub valid_params: Option<String>,
}

/// The response a JS handler returns (inside a `Promise`).
///
/// `headers` — ordered pairs, duplicates allowed (multiple `set-cookie`).
/// `streamed = true` → the body flows through `BodyIo::write` (a channel-backed
/// `Body`) and the `body` field is ignored. Otherwise the body is the `body` string.
#[napi(object)]
pub struct JsResponse {
    pub status: Option<u16>,
    pub headers: Option<Vec<KvPair>>,
    pub body: Option<String>,
    pub streamed: Option<bool>,
}

/// TSFN wrapper around the JS dispatcher: `(req, bodyIo) => Promise<res>`.
///
/// Callable from any tokio thread; `call_async` returns a `Promise` that we `await`
/// as a Rust `Future` (without blocking the thread).
pub type Handler = ThreadsafeFunction<
    (MatchedRequest, BodyIo), // T: data passed to call_async
    Promise<JsResponse>,      // Return: what JS returns (a Promise)
    (MatchedRequest, BodyIo), // CallJsBackArgs: arguments of the JS function
    Status,                   // ErrorStatus
    false,                    // CalleeHandled: we handle errors ourselves
>;
