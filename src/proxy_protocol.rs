//! PROXY protocol v1/v2 (§6c A4).
//!
//! Behind an L4 load balancer (AWS NLB, HAProxy in tcp mode) the TCP connection comes
//! from the LB itself, and the real client address is carried in a prefix ahead of the
//! data. We parse it before TLS/HTTP and use it as the peer IP; the `customIpHeaders`
//! chain then works as usual (§7: strip PROXY first, then look at headers).
//!
//! The mode is strict: when `proxyProtocol` is on, a connection **must** carry the
//! prefix or it is closed. Otherwise a client connecting around the LB could forge its
//! own address simply by omitting the prefix.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};

/// v2 signature: 12 bytes before the binary header.
const SIG_V2: [u8; 12] = [
    0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A,
];
/// v1 text prefix.
const SIG_V1: &[u8] = b"PROXY ";
/// Maximum v1 line length per the specification (including CRLF).
const MAX_V1: usize = 107;

/// Parse result: the source address, if one was supplied.
/// `None` — a valid prefix without an address (`LOCAL` in v2 / `UNKNOWN` in v1): usually
/// the balancer's own health check, so we keep the socket address.
type ParsedAddr = Option<String>;

/// Bytes of the header already read but not yet handed upstream.
pub struct PrefixedIo<S> {
    inner: S,
    /// Leftover of the buffer consumed while parsing the prefix (usually the start of TLS/HTTP).
    prefix: Vec<u8>,
    pos: usize,
}

impl<S> PrefixedIo<S> {
    pub fn new(inner: S, prefix: Vec<u8>) -> Self {
        PrefixedIo {
            inner,
            prefix,
            pos: 0,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedIo<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        // Replay the already-consumed leftover first, then switch to the socket.
        if me.pos < me.prefix.len() {
            let rest = &me.prefix[me.pos..];
            let n = rest.len().min(buf.remaining());
            buf.put_slice(&rest[..n]);
            me.pos += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut me.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedIo<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
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

/// Read and parse the PROXY prefix. Returns the wrapped stream and the client address
/// (`None` → keep the socket address). `Err(())` — no prefix or a malformed one.
pub async fn read_header<S: AsyncRead + Unpin>(
    mut stream: S,
) -> Result<(PrefixedIo<S>, ParsedAddr), ()> {
    let mut buf = Vec::with_capacity(256);

    // Minimum needed to tell the version apart: 12 bytes of the v2 signature or 6 of "PROXY ".
    read_at_least(&mut stream, &mut buf, 12).await?;

    if buf[..12] == SIG_V2 {
        return parse_v2(stream, buf).await;
    }
    if buf.starts_with(SIG_V1) {
        return parse_v1(stream, buf).await;
    }
    Err(())
}

/// Read up to `want` bytes (error if the stream ends first).
async fn read_at_least<S: AsyncRead + Unpin>(
    stream: &mut S,
    buf: &mut Vec<u8>,
    want: usize,
) -> Result<(), ()> {
    while buf.len() < want {
        let mut chunk = [0u8; 256];
        let n = stream.read(&mut chunk).await.map_err(|_| ())?;
        if n == 0 {
            return Err(()); // EOF before the header ended
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(())
}

/// v1: the text line `PROXY TCP4 src dst sport dport\r\n`.
async fn parse_v1<S: AsyncRead + Unpin>(
    mut stream: S,
    mut buf: Vec<u8>,
) -> Result<(PrefixedIo<S>, ParsedAddr), ()> {
    // Read up to CRLF, but no further than the spec's limit.
    let end = loop {
        if let Some(i) = find_crlf(&buf) {
            break i;
        }
        if buf.len() > MAX_V1 {
            return Err(());
        }
        let want = buf.len() + 1;
        read_at_least(&mut stream, &mut buf, want).await?;
    };

    let line = std::str::from_utf8(&buf[..end]).map_err(|_| ())?;
    let mut parts = line.split(' ');
    if parts.next() != Some("PROXY") {
        return Err(());
    }
    let addr = match parts.next() {
        Some("TCP4") | Some("TCP6") => parts.next().map(|s| s.to_string()),
        // UNKNOWN: the prefix is valid but carries no address — keep the socket one.
        Some("UNKNOWN") => None,
        _ => return Err(()),
    };

    let rest = buf.split_off(end + 2); // everything after CRLF is already protocol data
    Ok((PrefixedIo::new(stream, rest), addr))
}

/// v2: a binary header (16 bytes) plus a variable-length address block.
async fn parse_v2<S: AsyncRead + Unpin>(
    mut stream: S,
    mut buf: Vec<u8>,
) -> Result<(PrefixedIo<S>, ParsedAddr), ()> {
    read_at_least(&mut stream, &mut buf, 16).await?;

    let ver_cmd = buf[12];
    if ver_cmd >> 4 != 2 {
        return Err(()); // version is not 2
    }
    let is_proxy = ver_cmd & 0x0F == 1; // 0 = LOCAL (no address), 1 = PROXY
    let family = buf[13] >> 4; // 1 = AF_INET, 2 = AF_INET6
    let len = u16::from_be_bytes([buf[14], buf[15]]) as usize;

    read_at_least(&mut stream, &mut buf, 16 + len).await?;
    let addr_block = &buf[16..16 + len];

    let addr = if !is_proxy {
        None
    } else {
        match family {
            1 if addr_block.len() >= 12 => {
                let a = &addr_block[0..4];
                Some(format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3]))
            }
            2 if addr_block.len() >= 36 => {
                let mut segments = [0u16; 8];
                for (i, seg) in segments.iter_mut().enumerate() {
                    *seg = u16::from_be_bytes([addr_block[i * 2], addr_block[i * 2 + 1]]);
                }
                Some(std::net::Ipv6Addr::from(segments).to_string())
            }
            // AF_UNIX or an unknown family — no address taken, but the prefix is valid.
            _ => None,
        }
    };

    let rest = buf.split_off(16 + len);
    Ok((PrefixedIo::new(stream, rest), addr))
}

fn find_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run the parser over a fake stream and return (address, leftover data).
    async fn run(input: &[u8]) -> Result<(Option<String>, Vec<u8>), ()> {
        let (mut io, addr) = read_header(std::io::Cursor::new(input.to_vec())).await?;
        let mut rest = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut io, &mut rest)
            .await
            .map_err(|_| ())?;
        Ok((addr, rest))
    }

    #[tokio::test]
    async fn v1_tcp4() {
        let (addr, rest) = run(b"PROXY TCP4 192.168.0.1 10.0.0.1 56324 443\r\nGET / HTTP/1.1\r\n")
            .await
            .unwrap();
        assert_eq!(addr.as_deref(), Some("192.168.0.1"));
        assert_eq!(rest, b"GET / HTTP/1.1\r\n");
    }

    #[tokio::test]
    async fn v1_unknown_keeps_socket_addr() {
        let (addr, rest) = run(b"PROXY UNKNOWN\r\nDATA").await.unwrap();
        assert_eq!(addr, None);
        assert_eq!(rest, b"DATA");
    }

    #[tokio::test]
    async fn v2_ipv4() {
        let mut h = SIG_V2.to_vec();
        h.push(0x21); // version 2, PROXY command
        h.push(0x11); // AF_INET / STREAM
        h.extend_from_slice(&12u16.to_be_bytes());
        h.extend_from_slice(&[10, 1, 2, 3]); // src
        h.extend_from_slice(&[10, 9, 9, 9]); // dst
        h.extend_from_slice(&[0x1F, 0x90]); // sport
        h.extend_from_slice(&[0x01, 0xBB]); // dport
        h.extend_from_slice(b"PAYLOAD");

        let (addr, rest) = run(&h).await.unwrap();
        assert_eq!(addr.as_deref(), Some("10.1.2.3"));
        assert_eq!(rest, b"PAYLOAD");
    }

    #[tokio::test]
    async fn v2_local_has_no_addr() {
        let mut h = SIG_V2.to_vec();
        h.push(0x20); // version 2, LOCAL command
        h.push(0x00);
        h.extend_from_slice(&0u16.to_be_bytes());
        h.extend_from_slice(b"X");

        let (addr, rest) = run(&h).await.unwrap();
        assert_eq!(addr, None);
        assert_eq!(rest, b"X");
    }

    #[tokio::test]
    async fn plain_http_without_prefix_rejected() {
        assert!(run(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.is_err());
    }
}
