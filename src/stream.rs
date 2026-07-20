//! Request/response body bridge across the napi boundary with backpressure (§9).
//!
//! `BodyIo` is a napi class handed to the JS dispatcher. `read()` pulls request body
//! chunks (Rust→JS); `write()/endWrite()` push the response body (JS→Rust).
//! Both directions use bounded channels (cap 1), so backpressure comes for free.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::task::{Context, Poll};

use bytes::Bytes;
use hyper::body::{Body, Frame};
use napi::bindgen_prelude::Buffer;
use napi::Result;
use napi_derive::napi;
use tokio::sync::mpsc::{Receiver, Sender};
use tokio::sync::Mutex as TokioMutex;

use crate::multipart::MpEvent;

/// Body channel capacity: one chunk in flight → tight backpressure.
pub const BODY_CHANNEL_CAP: usize = 1;

/// Body-limit exceeded marker, surfaced to JS through `read()` (→ 413).
pub const BODY_LIMIT_EXCEEDED: &str = "BODY_LIMIT_EXCEEDED";

/// Expired `bodyReadTimeout` marker (→ 408).
pub const BODY_READ_TIMEOUT: &str = "BODY_READ_TIMEOUT";

/// Connection died mid-body marker (→ 400): what arrived is truncated.
pub const BODY_READ_ABORTED: &str = "BODY_READ_ABORTED";

/// Request body channel message: data or the reason the stream was cut.
pub enum BodyMsg {
    Data(Bytes),
    /// The body exceeded body-limit — we stopped reading the socket (DoS guard).
    Overflow,
    /// The client was silent longer than `bodyReadTimeout` — reading aborted (§6c A2).
    Timeout,
    /// The connection failed part-way through the body. Distinct from a clean end:
    /// reporting it as "body finished" would hand JS a partial payload as complete.
    Aborted,
}

/// Tells JS how the request future ended: dropped by hyper (the connection died) or
/// completed normally.
///
/// It fires in **both** cases on purpose. JS awaits it once per request when a handler
/// cares about disconnects, and a future that resolved only on abort would stay pending
/// forever on every successfully served request — a leak per request.
pub struct AbortSignal {
    notify: tokio::sync::Notify,
    aborted: AtomicBool,
}

impl Default for AbortSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl AbortSignal {
    pub fn new() -> Self {
        // Armed by default: only producing a response disarms it, so a future dropped
        // part-way is correctly reported as an abort.
        AbortSignal {
            notify: tokio::sync::Notify::new(),
            aborted: AtomicBool::new(true),
        }
    }

    /// A response was produced — this was not an abort.
    pub fn complete(&self) {
        self.aborted.store(false, Ordering::Relaxed);
    }

    /// Wake the JS waiter. `notify_one` stores a permit, so a waiter that arrives late
    /// still sees it.
    pub fn fire(&self) {
        self.notify.notify_one();
    }
}

/// Multipart part metadata for JS.
#[napi(object)]
pub struct PartMeta {
    pub name: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
}

/// Multipart stream read state.
struct MpState {
    rx: Receiver<MpEvent>,
    ended: bool, // the current part is finished (read_part → null)
}

/// Body bridge for a single request. Created in Rust, handed to JS as an argument.
#[napi]
pub struct BodyIo {
    /// Receiver of request body chunks (None → no body / multipart).
    req_rx: TokioMutex<Option<Receiver<BodyMsg>>>,
    /// Sender of response body chunks (None after endWrite / when not streaming).
    resp_tx: StdMutex<Option<Sender<Bytes>>>,
    /// Multipart event stream (None → the route is not multipart).
    mp: TokioMutex<Option<MpState>>,
    /// How this request ended — see `wait_abort`.
    abort: Arc<AbortSignal>,
}

impl BodyIo {
    pub fn new(
        req_rx: Option<Receiver<BodyMsg>>,
        resp_tx: Option<Sender<Bytes>>,
        mp_rx: Option<Receiver<MpEvent>>,
        abort: Arc<AbortSignal>,
    ) -> Self {
        BodyIo {
            req_rx: TokioMutex::new(req_rx),
            resp_tx: StdMutex::new(resp_tx),
            mp: TokioMutex::new(mp_rx.map(|rx| MpState { rx, ended: false })),
            abort,
        }
    }
}

#[napi]
impl BodyIo {
    /// Read the next request body chunk. `null` = end of body.
    /// Backpressure JS→Rust: the socket is only read when JS calls read().
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        let mut guard = self.req_rx.lock().await;
        match guard.as_mut() {
            Some(rx) => match rx.recv().await {
                Some(BodyMsg::Data(b)) => Ok(Some(b.to_vec().into())),
                // Limit exceeded → error in JS (mapped to 413). No further reads.
                Some(BodyMsg::Overflow) => Err(napi::Error::from_reason(BODY_LIMIT_EXCEEDED)),
                // Client silent longer than bodyReadTimeout → 408.
                Some(BodyMsg::Timeout) => Err(napi::Error::from_reason(BODY_READ_TIMEOUT)),
                // Connection dropped mid-body → 400; never a silent short read.
                Some(BodyMsg::Aborted) => Err(napi::Error::from_reason(BODY_READ_ABORTED)),
                None => Ok(None),
            },
            None => Ok(None),
        }
    }

    /// Write a response body chunk. Resolves once the channel accepts it (backpressure
    /// Rust→JS: hyper drains it as the socket frees up).
    #[napi]
    pub async fn write(&self, chunk: Buffer) -> Result<()> {
        let tx = self.resp_tx.lock().unwrap().clone();
        if let Some(tx) = tx {
            tx.send(Bytes::copy_from_slice(&chunk))
                .await
                .map_err(|_| napi::Error::from_reason("response body closed"))?;
        }
        Ok(())
    }

    /// Finish the response body (close the channel → hyper sees the end).
    #[napi]
    pub fn end_write(&self) {
        self.resp_tx.lock().unwrap().take();
    }

    /// How the request ended: `true` — the client went away before a response was
    /// produced, `false` — it completed normally.
    ///
    /// Hyper dropping the request future is the only disconnect notification available,
    /// so this is what backs `onAbort` and `c.req.signal`. JS subscribes only when a
    /// handler will act on it: the promise costs a pending task per request.
    #[napi]
    pub async fn wait_abort(&self) -> Result<bool> {
        self.abort.notify.notified().await;
        Ok(self.abort.aborted.load(Ordering::Relaxed))
    }

    /// Next multipart part (skipping the tail of an unread one). `null` = end of form.
    #[napi]
    pub async fn next_part(&self) -> Result<Option<PartMeta>> {
        let mut guard = self.mp.lock().await;
        let Some(state) = guard.as_mut() else {
            return Ok(None);
        };
        loop {
            match state.rx.recv().await {
                Some(MpEvent::Part {
                    name,
                    filename,
                    content_type,
                }) => {
                    state.ended = false;
                    return Ok(Some(PartMeta {
                        name,
                        filename,
                        content_type,
                    }));
                }
                // Tail of an abandoned part — skip ahead to the next Part.
                Some(MpEvent::Chunk(_)) | Some(MpEvent::PartEnd) => continue,
                Some(MpEvent::Reject { status, message }) => {
                    return Err(mp_reject(status, &message))
                }
                None => return Ok(None),
            }
        }
    }

    /// Next chunk of the current part. `null` = end of part.
    #[napi]
    pub async fn read_part(&self) -> Result<Option<Buffer>> {
        let mut guard = self.mp.lock().await;
        let Some(state) = guard.as_mut() else {
            return Ok(None);
        };
        if state.ended {
            return Ok(None);
        }
        match state.rx.recv().await {
            Some(MpEvent::Chunk(b)) => Ok(Some(b.to_vec().into())),
            Some(MpEvent::PartEnd) => {
                state.ended = true;
                Ok(None)
            }
            Some(MpEvent::Reject { status, message }) => Err(mp_reject(status, &message)),
            // Safety net: a Part without a preceding next_part, or end of stream.
            Some(MpEvent::Part { .. }) | None => {
                state.ended = true;
                Ok(None)
            }
        }
    }
}

/// Multipart rejection error encoding an HTTP status (JS maps it to HttpError).
fn mp_reject(status: u16, message: &str) -> napi::Error {
    napi::Error::from_reason(format!("MULTIPART_REJECT:{status}:{message}"))
}

/// A hyper `Body` pulling chunks from a channel (fed by `BodyIo::write`).
pub struct ChannelBody {
    rx: Receiver<Bytes>,
    metrics: Arc<crate::metrics::Metrics>,
}

impl ChannelBody {
    pub fn new(rx: Receiver<Bytes>, metrics: Arc<crate::metrics::Metrics>) -> Self {
        ChannelBody { rx, metrics }
    }
}

impl Body for ChannelBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, Infallible>>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(b)) => {
                // Counted here rather than in build_response: streamed bodies never pass
                // through it, so they were missing from the byte counter entirely.
                self.metrics.add_response_bytes(b.len() as u64);
                Poll::Ready(Some(Ok(Frame::data(b))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
