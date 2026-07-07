//! Мост тел запроса/ответа через границу napi с backpressure (§9).
//!
//! `BodyIo` — napi-класс, передаваемый в JS-диспетчер. `read()` тянет чанки
//! тела запроса (Rust→JS), `write()/endWrite()` пушат тело ответа (JS→Rust).
//! Оба направления — через bounded-каналы (cap 1): backpressure естественный.

use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Mutex as StdMutex;
use std::task::{Context, Poll};

use bytes::Bytes;
use hyper::body::{Body, Frame};
use napi::bindgen_prelude::Buffer;
use napi::Result;
use napi_derive::napi;
use tokio::sync::mpsc::{Receiver, Sender};
use tokio::sync::Mutex as TokioMutex;

/// Ёмкость каналов тела: 1 чанк «в полёте» → плотный backpressure.
pub const BODY_CHANNEL_CAP: usize = 1;

/// Мост тел одного запроса. Создаётся в Rust, отдаётся в JS как аргумент.
#[napi]
pub struct BodyIo {
    /// Приёмник чанков тела запроса (None → тела нет).
    req_rx: TokioMutex<Option<Receiver<Bytes>>>,
    /// Отправитель чанков тела ответа (None после endWrite / если не стримится).
    resp_tx: StdMutex<Option<Sender<Bytes>>>,
}

impl BodyIo {
    pub fn new(req_rx: Option<Receiver<Bytes>>, resp_tx: Option<Sender<Bytes>>) -> Self {
        BodyIo {
            req_rx: TokioMutex::new(req_rx),
            resp_tx: StdMutex::new(resp_tx),
        }
    }
}

#[napi]
impl BodyIo {
    /// Прочитать следующий чанк тела запроса. `null` = конец.
    /// Backpressure JS→Rust: сокет читается только когда JS дёрнул read().
    #[napi]
    pub async fn read(&self) -> Result<Option<Buffer>> {
        let mut guard = self.req_rx.lock().await;
        match guard.as_mut() {
            Some(rx) => Ok(rx.recv().await.map(|b| b.to_vec().into())),
            None => Ok(None),
        }
    }

    /// Записать чанк тела ответа. Резолвится, когда канал принял (backpressure
    /// Rust→JS: hyper забирает по мере разгрузки сокета).
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

    /// Завершить тело ответа (закрыть канал → hyper видит конец).
    #[napi]
    pub fn end_write(&self) {
        self.resp_tx.lock().unwrap().take();
    }
}

/// hyper-`Body`, тянущий чанки из канала (наполняется из `BodyIo::write`).
pub struct ChannelBody {
    rx: Receiver<Bytes>,
}

impl ChannelBody {
    pub fn new(rx: Receiver<Bytes>) -> Self {
        ChannelBody { rx }
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
            Poll::Ready(Some(b)) => Poll::Ready(Some(Ok(Frame::data(b)))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
