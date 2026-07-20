//! Request body decompression (§6b).
//!
//! Native schema validation needs the decoded document. Without this the validator saw a
//! compressed body as "absent" and answered `400 body is required` before JS ever woke —
//! a valid gzipped request could never succeed on a route with a body schema.
//!
//! The decoded size is bounded by the same body limit as the raw body: an unbounded
//! decode of attacker-supplied input is a zip bomb.

use std::io::Read;

use bytes::Bytes;

/// Why a body could not be decoded.
#[derive(Debug)]
pub enum DecodeErr {
    /// A `Content-Encoding` we do not implement (→ 415).
    Unsupported,
    /// Malformed compressed stream (→ 400).
    Invalid,
    /// Decoded output exceeded the body limit (→ 413).
    TooLarge,
}

/// Decode `body` according to `encoding` (already lowercased and never `identity`).
///
/// `deflate` is read as zlib-wrapped, matching `zlib.inflateSync` on the JS side — the
/// same request must behave identically whether or not the route has a schema.
pub fn decode(encoding: &str, body: &[u8], limit: Option<u64>) -> Result<Bytes, DecodeErr> {
    match encoding {
        "gzip" | "x-gzip" => read_bounded(flate2::read::GzDecoder::new(body), limit),
        "deflate" => read_bounded(flate2::read::ZlibDecoder::new(body), limit),
        "br" => read_bounded(brotli::Decompressor::new(body, 8192), limit),
        _ => Err(DecodeErr::Unsupported),
    }
}

/// Read a decoder to the end, giving up as soon as the output passes the limit.
fn read_bounded<R: Read>(mut r: R, limit: Option<u64>) -> Result<Bytes, DecodeErr> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = r.read(&mut chunk).map_err(|_| DecodeErr::Invalid)?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..n]);
        // Checked per chunk rather than at the end: a bomb must never be fully buffered.
        if limit.is_some_and(|l| out.len() as u64 > l) {
            return Err(DecodeErr::TooLarge);
        }
    }
    Ok(Bytes::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn gzip_roundtrip() {
        let raw = b"{\"name\":\"Bob\"}";
        let out = decode("gzip", &gzip(raw), None).unwrap();
        assert_eq!(&out[..], raw);
    }

    #[test]
    fn deflate_roundtrip() {
        let raw = b"hello deflate";
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(raw).unwrap();
        let out = decode("deflate", &e.finish().unwrap(), None).unwrap();
        assert_eq!(&out[..], raw);
    }

    #[test]
    fn unknown_encoding_is_unsupported() {
        assert!(matches!(
            decode("lzma", b"whatever", None),
            Err(DecodeErr::Unsupported)
        ));
    }

    #[test]
    fn malformed_stream_is_invalid() {
        assert!(matches!(
            decode("gzip", b"not actually gzip", None),
            Err(DecodeErr::Invalid)
        ));
    }

    #[test]
    fn zip_bomb_stops_at_the_limit() {
        // 1 MiB of zeros compresses to a few hundred bytes; with a 1 KiB limit the
        // decode must bail out instead of materialising the whole thing.
        let bomb = gzip(&vec![0u8; 1024 * 1024]);
        assert!(bomb.len() < 4096, "fixture should be small: {}", bomb.len());
        assert!(matches!(
            decode("gzip", &bomb, Some(1024)),
            Err(DecodeErr::TooLarge)
        ));
        // Exactly at the limit is fine.
        let ok = gzip(&vec![0u8; 1024]);
        assert_eq!(decode("gzip", &ok, Some(1024)).unwrap().len(), 1024);
    }
}
