//! Привязка сокета: TCP с socket-опциями (§6c B9) и Unix-сокет (§6c B9, `listen({path})`).
//!
//! Биндим синхронно, до старта рантайма: ошибки (EADDRINUSE, нет прав на путь)
//! доходят до JS как reject `listen()`, а не теряются в фоновой задаче.

use std::io;

use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpListener, UnixListener};

/// Настройки уровня сокета (§6c B9).
pub struct SocketOptions {
    /// Глубина очереди принятых, но не отданных accept'ом соединений.
    pub backlog: i32,
    /// `SO_REUSEPORT` — несколько процессов на одном порту (ядро балансирует).
    pub reuse_port: bool,
    /// `TCP_NODELAY` — выключить алгоритм Нагла (латентность API важнее пакетов).
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

/// Слушающий сокет: TCP или Unix.
pub enum Bound {
    Tcp(TcpListener),
    Unix(UnixListener),
}

/// Забиндить TCP-порт с заданными опциями.
pub fn bind_tcp(host: &str, port: u16, opts: &SocketOptions) -> io::Result<std::net::TcpListener> {
    let addr: std::net::SocketAddr =
        format!("{host}:{port}")
            .parse()
            .or_else(|_| -> io::Result<_> {
                // Не литеральный адрес (например "localhost") — резолвим.
                use std::net::ToSocketAddrs;
                (host, port).to_socket_addrs()?.next().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "адрес не резолвится")
                })
            })?;

    let domain = if addr.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    // SO_REUSEADDR: перезапуск не спотыкается о TIME_WAIT от прошлых соединений.
    socket.set_reuse_address(true)?;
    if opts.reuse_port {
        socket.set_reuse_port(true)?;
    }
    socket.bind(&addr.into())?;
    socket.listen(opts.backlog)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

/// Забиндить Unix-сокет по пути. Существующий файл сокета удаляем: после жёсткого
/// падения он остаётся на диске и bind падает с EADDRINUSE, хотя слушателя нет.
pub fn bind_unix(path: &str) -> io::Result<std::os::unix::net::UnixListener> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("{path}: файл существует и это не сокет"),
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
