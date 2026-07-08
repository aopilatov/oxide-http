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

use crate::multipart::MpEvent;

/// Ёмкость каналов тела: 1 чанк «в полёте» → плотный backpressure.
pub const BODY_CHANNEL_CAP: usize = 1;

/// Маркер превышения body-limit, передаётся в JS через `read()` (→ 413).
pub const BODY_LIMIT_EXCEEDED: &str = "BODY_LIMIT_EXCEEDED";

/// Сообщение канала тела запроса: данные либо превышение лимита.
pub enum BodyMsg {
    Data(Bytes),
    /// Тело превысило body-limit — читать сокет прекратили (защита от DoS).
    Overflow,
}

/// Метаданные части multipart для JS.
#[napi(object)]
pub struct PartMeta {
    pub name: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
}

/// Состояние чтения multipart-потока.
struct MpState {
    rx: Receiver<MpEvent>,
    ended: bool, // текущая часть закончилась (read_part → null)
}

/// Мост тел одного запроса. Создаётся в Rust, отдаётся в JS как аргумент.
#[napi]
pub struct BodyIo {
    /// Приёмник чанков тела запроса (None → тела нет / multipart).
    req_rx: TokioMutex<Option<Receiver<BodyMsg>>>,
    /// Отправитель чанков тела ответа (None после endWrite / если не стримится).
    resp_tx: StdMutex<Option<Sender<Bytes>>>,
    /// Поток событий multipart (None → маршрут не multipart).
    mp: TokioMutex<Option<MpState>>,
}

impl BodyIo {
    pub fn new(
        req_rx: Option<Receiver<BodyMsg>>,
        resp_tx: Option<Sender<Bytes>>,
        mp_rx: Option<Receiver<MpEvent>>,
    ) -> Self {
        BodyIo {
            req_rx: TokioMutex::new(req_rx),
            resp_tx: StdMutex::new(resp_tx),
            mp: TokioMutex::new(mp_rx.map(|rx| MpState { rx, ended: false })),
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
            Some(rx) => match rx.recv().await {
                Some(BodyMsg::Data(b)) => Ok(Some(b.to_vec().into())),
                // Превышение лимита → ошибка в JS (маппится в 413). Читать больше нельзя.
                Some(BodyMsg::Overflow) => Err(napi::Error::from_reason(BODY_LIMIT_EXCEEDED)),
                None => Ok(None),
            },
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

    /// Следующая часть multipart (пропуская хвост недочитанной). `null` = конец формы.
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
                // Хвост брошенной части — пропускаем до следующего Part.
                Some(MpEvent::Chunk(_)) | Some(MpEvent::PartEnd) => continue,
                Some(MpEvent::Reject { status, message }) => {
                    return Err(mp_reject(status, &message))
                }
                None => return Ok(None),
            }
        }
    }

    /// Следующий чанк текущей части. `null` = конец части.
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
            // Защита: Part без предшествующего next_part / конец потока.
            Some(MpEvent::Part { .. }) | None => {
                state.ended = true;
                Ok(None)
            }
        }
    }
}

/// Ошибка отклонения multipart, кодирующая HTTP-статус (JS маппит в HttpError).
fn mp_reject(status: u16, message: &str) -> napi::Error {
    napi::Error::from_reason(format!("MULTIPART_REJECT:{status}:{message}"))
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
