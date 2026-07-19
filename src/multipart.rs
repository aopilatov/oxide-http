//! Streaming `multipart/form-data` parsing in Rust (§9a) on top of `multer`.
//!
//! Parsing happens off the event loop, and per-route limits and type checks are applied
//! **before** the file reaches JS. JS receives an event stream (part → chunks → end)
//! with backpressure via a bounded channel. Nothing touches disk — streams only.

use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::BodyStream;
use hyper::body::Incoming;
use tokio::sync::mpsc::Sender;

/// Per-route multipart config (limits plus type restrictions).
#[derive(Clone, Default)]
pub struct MultipartConfig {
    pub max_file_size: Option<u64>,
    pub max_field_size: Option<u64>,
    pub max_files: Option<u32>,
    pub max_fields: Option<u32>,
    pub allowed_mime: Option<Vec<String>>, // patterns (lowercase), supports `image/*`
    pub allowed_ext: Option<Vec<String>>,  // extensions (lowercase, with the dot)
}

/// A parsing event sent to JS through the channel.
pub enum MpEvent {
    Part {
        name: Option<String>,
        filename: Option<String>,
        content_type: Option<String>,
    },
    Chunk(Bytes),
    PartEnd,
    /// Limit/type/format violation → an HTTP status (413/415/400) for the client.
    Reject {
        status: u16,
        message: String,
    },
}

/// Background task: parses the body and emits events. Stops at the first violation.
pub async fn parse_task(
    incoming: Incoming,
    boundary: String,
    cfg: MultipartConfig,
    tx: Sender<MpEvent>,
) {
    // Incoming → Stream<Result<Bytes, _>> for multer.
    let stream =
        BodyStream::new(incoming).map(|r| r.map(|frame| frame.into_data().unwrap_or_default()));
    let mut mp = multer::Multipart::new(stream, boundary);

    let mut files = 0u32;
    let mut fields = 0u32;

    loop {
        let mut field = match mp.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break, // end of form
            Err(_) => {
                let _ = tx.send(reject(400, "malformed multipart")).await;
                return;
            }
        };

        let name = field.name().map(String::from);
        let filename = field.file_name().map(String::from);
        let content_type = field.content_type().map(|m| m.to_string());
        let is_file = filename.is_some();

        // Count limits plus type checks (file parts only).
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
            return; // JS went away
        }

        // Stream the part's chunks with the per-part size limit.
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
                Ok(None) => break, // end of part
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
    // drop tx → channel closed → JS sees the end of the form
}

fn reject(status: u16, message: &str) -> MpEvent {
    MpEvent::Reject {
        status,
        message: message.to_string(),
    }
}

/// Is the part's Content-Type allowed? `image/*` is a prefix wildcard.
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

/// Is the file extension allowed?
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
        assert!(mime_allowed(Some("text/html"), &None)); // no restrictions
    }

    #[test]
    fn extension_check() {
        let exts = Some(vec![".png".to_string(), ".jpg".to_string()]);
        assert!(ext_allowed(Some("photo.PNG"), &exts)); // case-insensitive
        assert!(!ext_allowed(Some("evil.exe"), &exts));
        assert!(ext_allowed(None, &exts)); // not a file part
    }
}
