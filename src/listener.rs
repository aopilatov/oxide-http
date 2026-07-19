//! Socket binding: TCP with socket options (§6c B9) and Unix sockets
//! (§6c B9, `listen({path})`).
//!
//! We bind synchronously, before the runtime starts: errors (EADDRINUSE, no
//! permission for the path) reach JS as a rejected `listen()` instead of getting
//! lost in a background task.

use std::io;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpListener, UnixListener};

/// Socket-level settings (§6c B9).
pub struct SocketOptions {
    /// Depth of the queue of accepted-but-not-yet-handed-out connections.
    pub backlog: i32,
    /// `SO_REUSEPORT` — several processes on one port (the kernel balances).
    pub reuse_port: bool,
    /// `TCP_NODELAY` — disable Nagle's algorithm (API latency beats packet packing).
    pub nodelay: bool,
}

impl Default for SocketOptions {
    fn default() -> Self {
        SocketOptions {
            backlog: 1024,
            reuse_port: false,
            nodelay: true,
        }
    }
}

/// A listening socket: TCP or Unix.
pub enum Bound {
    Tcp(TcpListener),
    Unix(UnixListener),
}

/// Bind a TCP port with the given options.
pub fn bind_tcp(host: &str, port: u16, opts: &SocketOptions) -> io::Result<std::net::TcpListener> {
    let addr: std::net::SocketAddr =
        format!("{host}:{port}")
            .parse()
            .or_else(|_| -> io::Result<_> {
                // Not a literal address (e.g. "localhost") — resolve it.
                use std::net::ToSocketAddrs;
                (host, port).to_socket_addrs()?.next().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "address does not resolve")
                })
            })?;

    let domain = if addr.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    // SO_REUSEADDR: a restart does not trip over TIME_WAIT from past connections.
    socket.set_reuse_address(true)?;
    if opts.reuse_port {
        socket.set_reuse_port(true)?;
    }
    socket.bind(&addr.into())?;
    socket.listen(opts.backlog)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

/// Bind a Unix socket at the given path. An existing socket file is removed: after a
/// hard crash it stays on disk and bind fails with EADDRINUSE even with no listener.
pub fn bind_unix(path: &str) -> io::Result<std::os::unix::net::UnixListener> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("{path}: file exists and is not a socket"),
                ));
            }
            std::fs::remove_file(path)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }

    let listener = std::os::unix::net::UnixListener::bind(path)?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}
