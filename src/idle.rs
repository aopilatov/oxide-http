//! Idle-таймаут соединения (§6c A2).
//!
//! `ActivityIo` оборачивает сокет и отмечает момент последней полезной операции
//! (чтение/запись > 0 байт). Сторожевая задача `watch_idle` завершается, когда
//! активности не было дольше `idle` — вызывающий код гасит соединение по select'у.
//!
//! Обёртка навешивается на TCP-сокет **до** TLS, поэтому хендшейк тоже считается
//! активностью, а h1 keep-alive и простаивающие h2-соединения закрываются одинаково.

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Отметка активности: миллисекунды от `base` (общая точка отсчёта соединения).
#[derive(Clone)]
pub struct Activity {
    last_ms: Arc<AtomicU64>,
    /// Запросы в работе. Пока > 0, соединение не считается простаивающим, даже
    /// если по сокету ничего не идёт: долгий хендлер — это не Slowloris.
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

    /// Сколько прошло с последней активности.
    fn idle_for(&self) -> Duration {
        let now = self.base.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_ms.load(Ordering::Relaxed)))
    }

    /// Взять guard на время обработки запроса (RAII: decrement на Drop, в т.ч. при панике).
    pub fn request_guard(&self) -> RequestGuard {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        RequestGuard {
            in_flight: self.in_flight.clone(),
        }
    }
}

/// Пока жив — запрос считается активным (см. `Activity::request_guard`).
pub struct RequestGuard {
    in_flight: Arc<AtomicUsize>,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Ждать, пока соединение простаивает дольше `idle`. Возвращается — значит пора закрывать.
pub async fn watch_idle(activity: Activity, idle: Duration) {
    loop {
        // Есть запрос в работе → простоя нет; проверимся через окно заново.
        if activity.in_flight.load(Ordering::Relaxed) > 0 {
            tokio::time::sleep(idle).await;
            continue;
        }
        let quiet = activity.idle_for();
        if quiet >= idle {
            return;
        }
        // Спим ровно остаток окна: следующая проверка попадёт в момент истечения.
        tokio::time::sleep(idle - quiet).await;
    }
}

/// Сокет с отметкой активности. `S: Unpin` (TcpStream/TlsStream) — проекция не нужна.
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
