//! TLS через rustls (§12): сертификаты из PEM (путь/Buffer резолвит обёртка),
//! ALPN согласует `h2` / `http/1.1`.

use std::sync::Arc;

use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

/// Собрать `TlsAcceptor` из PEM-строк сертификата и ключа. ALPN: h2 + http/1.1.
pub fn build_acceptor(cert_pem: &str, key_pem: &str) -> Result<TlsAcceptor, String> {
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<_, _>>()
        .map_err(|e| format!("чтение сертификата: {e}"))?;
    if certs.is_empty() {
        return Err("сертификат не найден в PEM".into());
    }

    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|e| format!("чтение ключа: {e}"))?
        .ok_or_else(|| "приватный ключ не найден в PEM".to_string())?;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("конфиг TLS: {e}"))?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(TlsAcceptor::from(Arc::new(config)))
}
