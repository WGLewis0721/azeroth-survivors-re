//! A certificate minted on this machine so an iPhone can open the game over HTTPS.
//!
//! Safari enables WebGPU only in a secure context. `localhost` qualifies, and that is the
//! address a browser on this computer already uses, but a phone's localhost is the phone.
//! Reaching this host by its Wi-Fi address over plain HTTP loads the page and then dies inside
//! wgpu, because `navigator.gpu` is missing. The certificate below makes
//! `https://<lan-ip>:<tls-port>` a secure context. It is self-signed; Safari asks once
//! (Advanced → visit this website) and then keeps the exception for this certificate.

use std::fs;
use std::net::IpAddr;
use std::path::Path;

use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use rcgen::{CertificateParams, KeyPair, SanType};

/// PEM certificate and private key, either just generated or read back from [`load_or_create`].
pub struct DevCert {
    pub cert_pem: String,
    pub key_pem: String,
}

/// Build a server certificate whose SAN list is `dns` plus every address in `ips`.
///
/// iOS checks the IP the phone dialed against subjectAltName, not the common name. A certificate
/// that only says `localhost` is rejected for `https://192.168.x.x` and the secure-context
/// exception never sticks.
pub fn generate(dns: &[&str], ips: &[IpAddr]) -> Result<DevCert> {
    let names: Vec<String> = dns.iter().map(|s| (*s).to_string()).collect();
    let mut params = CertificateParams::new(names).context("certificate names")?;
    for ip in ips {
        params.subject_alt_names.push(SanType::IpAddress(*ip));
    }
    let key = KeyPair::generate().context("certificate key")?;
    let cert = params.self_signed(&key).context("self-sign")?;
    Ok(DevCert {
        cert_pem: cert.pem(),
        key_pem: key.serialize_pem(),
    })
}

/// Reuse `dir`'s certificate when it was minted for this exact name and address list.
///
/// A new certificate every launch makes Safari show the warning every launch. The files are
/// gitignored (`.wenilla-tls/`); losing them only costs one more tap.
pub fn load_or_create(dir: &Path, dns: &[&str], ips: &[IpAddr]) -> Result<DevCert> {
    let stamp = stamp(dns, ips);
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    let stamp_path = dir.join("stamp.txt");
    if let (Ok(saved), Ok(cert_pem), Ok(key_pem)) = (
        fs::read_to_string(&stamp_path),
        fs::read_to_string(&cert_path),
        fs::read_to_string(&key_path),
    ) {
        if saved == stamp && !cert_pem.is_empty() && !key_pem.is_empty() {
            return Ok(DevCert { cert_pem, key_pem });
        }
    }
    let fresh = generate(dns, ips)?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    fs::write(&cert_path, &fresh.cert_pem)?;
    fs::write(&key_path, &fresh.key_pem)?;
    fs::write(&stamp_path, &stamp)?;
    Ok(fresh)
}

fn stamp(dns: &[&str], ips: &[IpAddr]) -> String {
    let mut ips: Vec<_> = ips.iter().map(|ip| ip.to_string()).collect();
    ips.sort();
    format!("dns={}\nips={}\n", dns.join(","), ips.join(","))
}

/// rustls config for [`axum_server`], from a [`DevCert`]. Installs the ring provider once;
/// rustls 0.23 refuses to build a config until a process-wide provider exists.
pub async fn rustls_config(cert: &DevCert) -> Result<RustlsConfig> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    RustlsConfig::from_pem(
        cert.cert_pem.clone().into_bytes(),
        cert.key_pem.clone().into_bytes(),
    )
    .await
    .context("loading the generated certificate")
}

/// Addresses worth putting on the certificate: loopback, plus the Wi-Fi address a default-route
/// probe reports. UDP connect does not transmit; it only asks the kernel which source it would use.
pub fn listen_ips() -> Vec<IpAddr> {
    let mut ips = vec![IpAddr::from([127, 0, 0, 1])];
    if let Some(ip) = lan_ip() {
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    ips
}

#[cfg(test)]
mod handshake {
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[tokio::test]
    async fn https_serves_the_page_a_phone_opens() {
        let cert = generate(&["localhost"], &[IpAddr::from([127, 0, 0, 1])]).unwrap();
        let config = rustls_config(&cert).await.unwrap();
        let www = std::env::temp_dir().join(format!(
            "wenilla-https-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&www).unwrap();
        fs::write(www.join("index.html"), "phone-ok").unwrap();
        let app = crate::static_site::router(&www);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = axum_server::from_tcp_rustls(listener, config);
        tokio::spawn(async move {
            let _ = server.serve(app.into_make_service()).await;
        });

        let mut roots = rustls::RootCertStore::empty();
        let mut cursor = std::io::Cursor::new(cert.cert_pem.as_bytes());
        for der in rustls_pemfile::certs(&mut cursor) {
            roots.add(der.unwrap()).unwrap();
        }
        let client = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let name = rustls::pki_types::ServerName::try_from("localhost")
            .unwrap()
            .to_owned();
        let mut tls = connector.connect(name, stream).await.unwrap();
        tls.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut buf = Vec::new();
        tls.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("200"), "{text}");
        assert!(text.contains("phone-ok"), "{text}");
        let _ = fs::remove_dir_all(&www);
    }
}

fn lan_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use super::*;

    #[test]
    fn the_certificate_names_the_address_a_phone_dials() {
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let cert = generate(&["localhost"], &[IpAddr::from([127, 0, 0, 1]), ip]).unwrap();
        let (_, pem) = x509_parser::pem::parse_x509_pem(cert.cert_pem.as_bytes()).unwrap();
        let x509 = pem.parse_x509().unwrap();
        let san = x509
            .subject_alternative_name()
            .unwrap()
            .expect("subjectAltName");
        let ips: Vec<Vec<u8>> = san
            .value
            .general_names
            .iter()
            .filter_map(|name| match name {
                x509_parser::extensions::GeneralName::IPAddress(bytes) => Some(bytes.to_vec()),
                _ => None,
            })
            .collect();
        assert!(
            ips.iter().any(|b| b == &[192, 168, 1, 20]),
            "iOS matches the URL host against an IP SAN, got {ips:?}"
        );
        assert!(ips.iter().any(|b| b == &[127, 0, 0, 1]));
    }

    #[test]
    fn a_second_launch_reuses_the_certificate() {
        let dir = std::env::temp_dir().join(format!("wenilla-tls-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let ips = [IpAddr::from([127, 0, 0, 1])];
        let first = load_or_create(&dir, &["localhost"], &ips).unwrap();
        let second = load_or_create(&dir, &["localhost"], &ips).unwrap();
        assert_eq!(first.cert_pem, second.cert_pem);
        let changed = load_or_create(&dir, &["localhost"], &[IpAddr::from([10, 0, 0, 8])]).unwrap();
        assert_ne!(
            first.cert_pem, changed.cert_pem,
            "a new LAN address must be on the certificate or the phone cannot open it"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
