//! TLS via rustls (§12): certificates from PEM (the wrapper resolves path/Buffer),
//! ALPN negotiates `h2` / `http/1.1`.

use std::sync::Arc;

use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;

/// Build a `TlsAcceptor` from certificate and key PEM strings. ALPN: h2 + http/1.1.
pub fn build_acceptor(cert_pem: &str, key_pem: &str) -> Result<TlsAcceptor, String> {
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert_pem.as_bytes())
        .collect::<Result<_, _>>()
        .map_err(|e| format!("reading certificate: {e}"))?;
    if certs.is_empty() {
        return Err("no certificate found in PEM".into());
    }

    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_pem.as_bytes())
        .map_err(|e| format!("reading key: {e}"))?
        .ok_or_else(|| "no private key found in PEM".to_string())?;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| format!("TLS config: {e}"))?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

    Ok(TlsAcceptor::from(Arc::new(config)))
}
