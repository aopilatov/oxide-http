//! Connection idle timeout (§6c A2).
//!
//! `ActivityIo` wraps the socket and records the moment of the last useful operation
//! (a read/write of more than 0 bytes). The `watch_idle` watchdog returns once there
//! has been no activity for longer than `idle` — the caller then drops the connection
//! via `select!`.
//!
//! The wrapper sits on the TCP socket **before** TLS, so the handshake counts as
//! activity too, and h1 keep-alive and idle h2 connections are closed the same way.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Activity marker: milliseconds since `base` (the connection's common origin).
#[derive(Clone)]
pub struct Activity {
    last_ms: Arc<AtomicU64>,
    /// Requests in flight. While > 0 the connection is not considered idle even if
    /// nothing moves on the socket: a slow handler is not a Slowloris.
    in_flight: Arc<AtomicUsize>,
    base: Instant,
}

impl Activity {
    pub fn new() -> Self {
        Activity {
            last_ms: Arc::new(AtomicU64::new(0)),
            in_flight: Arc::new(AtomicUsize::new(0)),
            base: Instant::now(),
        }
    }

    fn touch(&self) {
        self.last_ms
            .store(self.base.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    /// How long since the last activity.
    fn idle_for(&self) -> Duration {
        let now = self.base.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_ms.load(Ordering::Relaxed)))
    }

    /// Take a guard for the duration of request handling (RAII: decrements on Drop,
    /// including on panic).
    pub fn request_guard(&self) -> RequestGuard {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        RequestGuard {
            in_flight: self.in_flight.clone(),
        }
    }
}

/// While alive the request counts as active (see `Activity::request_guard`).
pub struct RequestGuard {
    in_flight: Arc<AtomicUsize>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Wait until the connection has been idle longer than `idle`. Returning means it is
/// time to close.
pub async fn watch_idle(activity: Activity, idle: Duration) {
    loop {
        // A request is in flight → not idle; re-check after another window.
        if activity.in_flight.load(Ordering::Relaxed) > 0 {
            tokio::time::sleep(idle).await;
            continue;
        }
        let quiet = activity.idle_for();
        if quiet >= idle {
            return;
        }
        // Sleep exactly the remainder of the window: the next check lands on expiry.
        tokio::time::sleep(idle - quiet).await;
    }
}

/// A socket with activity tracking. `S: Unpin` (TcpStream/TlsStream) — no pin projection needed.
pub struct ActivityIo<S> {
    inner: S,
    activity: Activity,
}

impl<S> ActivityIo<S> {
    pub fn new(inner: S, activity: Activity) -> Self {
        ActivityIo { inner, activity }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for ActivityIo<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        let before = buf.filled().len();
        let r = Pin::new(&mut me.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            me.activity.touch();
        }
        r
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for ActivityIo<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        let r = Pin::new(&mut me.inner).poll_write(cx, buf);
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) {
            me.activity.touch();
        }
        r
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        let r = Pin::new(&mut me.inner).poll_write_vectored(cx, bufs);
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) {
            me.activity.touch();
        }
        r
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
