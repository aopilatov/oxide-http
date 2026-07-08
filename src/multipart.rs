//! Потоковый парсинг `multipart/form-data` в Rust (§9a) на `multer`.
//!
//! Парсим вне event loop, применяем per-route лимиты и проверки типов **до**
//! передачи файла в JS. Отдаём в JS поток событий (часть → чанки → конец),
//! backpressure — через bounded-канал. Диск не трогаем (только потоки).

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::BodyStream;
use hyper::body::Incoming;
use tokio::sync::mpsc::Sender;

/// Per-route конфиг multipart (лимиты + ограничения типов).
#[derive(Clone, Default)]
pub struct MultipartConfig {
    pub max_file_size: Option<u64>,
    pub max_field_size: Option<u64>,
    pub max_files: Option<u32>,
    pub max_fields: Option<u32>,
    pub allowed_mime: Option<Vec<String>>, // паттерны (lowercase), поддержка `image/*`
    pub allowed_ext: Option<Vec<String>>,  // расширения (lowercase, с точкой)
}

/// Событие парсинга, уходящее в JS через канал.
pub enum MpEvent {
    Part {
        name: Option<String>,
        filename: Option<String>,
        content_type: Option<String>,
    },
    Chunk(Bytes),
    PartEnd,
    /// Нарушение лимита/типа/формата → HTTP-статус (413/415/400) для клиента.
    Reject {
        status: u16,
        message: String,
    },
}

/// Фоновая задача: парсит тело, шлёт события. Прерывается на первом нарушении.
pub async fn parse_task(
    incoming: Incoming,
    boundary: String,
    cfg: MultipartConfig,
    tx: Sender<MpEvent>,
) {
    // Incoming → Stream<Result<Bytes, _>> для multer.
    let stream =
        BodyStream::new(incoming).map(|r| r.map(|frame| frame.into_data().unwrap_or_default()));
    let mut mp = multer::Multipart::new(stream, boundary);

    let mut files = 0u32;
    let mut fields = 0u32;

    loop {
        let mut field = match mp.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break, // конец формы
            Err(_) => {
                let _ = tx.send(reject(400, "malformed multipart")).await;
                return;
            }
        };

        let name = field.name().map(String::from);
        let filename = field.file_name().map(String::from);
        let content_type = field.content_type().map(|m| m.to_string());
        let is_file = filename.is_some();

        // Лимиты по количеству + проверки типов (только для файловых частей).
        if is_file {
            files += 1;
            if cfg.max_files.is_some_and(|m| files > m) {
                let _ = tx.send(reject(400, "too many files")).await;
                return;
            }
            if !mime_allowed(content_type.as_deref(), &cfg.allowed_mime) {
                let _ = tx.send(reject(415, "mime type not allowed")).await;
                return;
            }
            if !ext_allowed(filename.as_deref(), &cfg.allowed_ext) {
                let _ = tx.send(reject(415, "file extension not allowed")).await;
                return;
            }
        } else {
            fields += 1;
            if cfg.max_fields.is_some_and(|m| fields > m) {
                let _ = tx.send(reject(400, "too many fields")).await;
                return;
            }
        }

        if tx
            .send(MpEvent::Part {
                name,
                filename,
                content_type,
            })
            .await
            .is_err()
        {
            return; // JS отвалился
        }

        // Стримим чанки части с per-part лимитом размера.
        let limit = if is_file {
            cfg.max_file_size
        } else {
            cfg.max_field_size
        };
        let mut size: u64 = 0;
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    size = size.saturating_add(chunk.len() as u64);
                    if limit.is_some_and(|l| size > l) {
                        let status = if is_file { 413 } else { 400 };
                        let _ = tx.send(reject(status, "part too large")).await;
                        return;
                    }
                    if tx.send(MpEvent::Chunk(chunk)).await.is_err() {
                        return;
                    }
                }
                Ok(None) => break, // конец части
                Err(_) => {
                    let _ = tx.send(reject(400, "malformed multipart")).await;
                    return;
                }
            }
        }

        if tx.send(MpEvent::PartEnd).await.is_err() {
            return;
        }
    }
    // drop tx → канал закрыт → JS видит конец формы
}

fn reject(status: u16, message: &str) -> MpEvent {
    MpEvent::Reject {
        status,
        message: message.to_string(),
    }
}

/// Тип части (Content-Type) разрешён? `image/*` — wildcard по префиксу.
fn mime_allowed(ct: Option<&str>, patterns: &Option<Vec<String>>) -> bool {
    let Some(patterns) = patterns else {
        return true;
    };
    let ct = ct.unwrap_or("").to_lowercase();
    let main = ct.split(';').next().unwrap_or("").trim();
    patterns.iter().any(|p| {
        if let Some(prefix) = p.strip_suffix("/*") {
            main.starts_with(&format!("{prefix}/"))
        } else {
            main == p
        }
    })
}

/// Расширение файла разрешено?
fn ext_allowed(filename: Option<&str>, exts: &Option<Vec<String>>) -> bool {
    let Some(exts) = exts else {
        return true;
    };
    let Some(fname) = filename else {
        return true;
    };
    let lower = fname.to_lowercase();
    exts.iter().any(|e| lower.ends_with(e.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_wildcard() {
        let pats = Some(vec!["image/*".to_string(), "application/pdf".to_string()]);
        assert!(mime_allowed(Some("image/png"), &pats));
        assert!(mime_allowed(Some("image/jpeg; charset=x"), &pats));
        assert!(mime_allowed(Some("application/pdf"), &pats));
        assert!(!mime_allowed(Some("text/html"), &pats));
        assert!(mime_allowed(Some("text/html"), &None)); // нет ограничений
    }

    #[test]
    fn extension_check() {
        let exts = Some(vec![".png".to_string(), ".jpg".to_string()]);
        assert!(ext_allowed(Some("photo.PNG"), &exts)); // регистронезависимо
        assert!(!ext_allowed(Some("evil.exe"), &exts));
        assert!(ext_allowed(None, &exts)); // не файловая часть
    }
}
