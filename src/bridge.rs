//! The Rust↔JS bridge: types that cross the boundary and the batched dispatch queue.
//!
//! One JS wakeup serves N requests (§19). Ready requests are pushed into a queue; the
//! doorbell TSFN fires only when the queue transitions empty → non-empty. On the JS
//! side the dispatcher drains the queue with `takeBatch()` (one call returns every
//! pending request), runs the handlers, and finishes each request with a synchronous
//! `respond(reqId, res)` — no `Promise` ever crosses the boundary. `BodyIo` is created
//! lazily via `takeBody(reqId)`, so a bodyless GET never pays for it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use tokio::sync::mpsc::{Receiver, Sender};
use tokio::sync::oneshot;

use crate::multipart::MpEvent;
use crate::stream::{AbortSignal, BodyIo, BodyMsg};

/// Key-value pair (for query strings, where keys may repeat).
#[napi(object)]
pub struct KvPair {
    pub key: String,
    pub value: String,
}

/// A matched request handed to the JS dispatcher inside a batch (§19).
///
/// `req_id` — the ticket for `takeBody`/`respond`.
/// `leaf_id` — index of the route leaf in the JS handler registry; `-1` = notFound.
/// `path` — full path (including baseUrl); the wrapper strips the prefix for `c.req.path`.
/// `ip`/`ips`/`country`/`id` are computed in Rust (§7, §6d B2).
#[napi(object)]
pub struct MatchedRequest {
    pub req_id: u32,
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
    /// Validated/coerced values (JSON strings) — present when the leaf has a schema.
    /// `c.req.valid('body'|'query'|'params')` in JS then applies the valibot transform.
    pub valid_body: Option<String>,
    pub valid_query: Option<String>,
    pub valid_params: Option<String>,
}

/// The response a JS handler passes to `respond()`.
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

/// The doorbell: wakes the JS dispatcher when the queue becomes non-empty. Carries no
/// payload — JS pulls the actual requests with `takeBatch()`.
pub type Doorbell = ThreadsafeFunction<(), (), (), Status, false>;

/// Channel ends a request's `BodyIo` is built from (lazily, via `takeBody`).
pub struct BodyParts {
    pub req_rx: Option<Receiver<BodyMsg>>,
    pub resp_tx: Option<Sender<Bytes>>,
    pub mp_rx: Option<Receiver<MpEvent>>,
    pub abort: Arc<AbortSignal>,
}

/// The server side of one in-flight request.
pub struct Pending {
    /// Taken (at most once) by `takeBody`.
    pub body: Option<BodyParts>,
    /// Completed by `respond`; dropping it makes the dispatcher answer 500.
    pub done: oneshot::Sender<JsResponse>,
}

/// The batched dispatch queue shared by every connection task (§19).
pub struct Bridge {
    doorbell: Doorbell,
    /// Requests waiting for the JS dispatcher (drained whole by `takeBatch`).
    queue: Mutex<Vec<MatchedRequest>>,
    /// In-flight requests by `req_id` (channel ends + completion).
    pending: Mutex<HashMap<u32, Pending>>,
    next_id: AtomicU32,
}

impl Bridge {
    pub fn new(doorbell: Doorbell) -> Self {
        Bridge {
            doorbell,
            queue: Mutex::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(0),
        }
    }

    pub fn next_req_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Register the request and hand it to JS. The doorbell rings only on the
    /// empty → non-empty transition: while JS is draining, new arrivals ride along in
    /// the next `takeBatch` without another wakeup — that is the whole amortization.
    pub fn enqueue(&self, req: MatchedRequest, pending: Pending) {
        self.pending.lock().unwrap().insert(req.req_id, pending);
        let was_empty = {
            let mut q = self.queue.lock().unwrap();
            let was_empty = q.is_empty();
            q.push(req);
            was_empty
        };
        if was_empty {
            self.doorbell
                .call((), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    /// Everything queued right now (called from the JS thread).
    pub fn take_batch(&self) -> Vec<MatchedRequest> {
        std::mem::take(&mut *self.queue.lock().unwrap())
    }

    /// Build the `BodyIo` for a request — at most once (the parts move out).
    pub fn take_body(&self, req_id: u32) -> Option<BodyIo> {
        let parts = self
            .pending
            .lock()
            .unwrap()
            .get_mut(&req_id)
            .and_then(|p| p.body.take())?;
        Some(BodyIo::new(
            parts.req_rx,
            parts.resp_tx,
            parts.mp_rx,
            parts.abort,
        ))
    }

    /// Complete a request. Idempotent: an unknown/already-completed id is a no-op, and
    /// a receiver that vanished (the client disconnected mid-flight) is ignored.
    pub fn respond(&self, req_id: u32, res: JsResponse) {
        if let Some(p) = self.pending.lock().unwrap().remove(&req_id) {
            let _ = p.done.send(res);
        }
    }
}
