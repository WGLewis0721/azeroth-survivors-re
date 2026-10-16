//! `wenilla-host` — the piece of the browser build that can't be static hosting: it serves the
//! wasm bundle, answers game-data reads out of the real MPQ chain, and proxies the two TCP ports
//! the client needs (login 3724, world 8085) over WebSocket, since a browser tab cannot open a
//! raw socket. See `web/README.md` for
//! the exact URL/encoding rules the client lanes code against.
//!
//! This host is a **local development tool**. `/data` hands out the operator's game files to
//! anyone who can reach the socket, with no login, so it binds to loopback by default and must
//! never be exposed on the open internet. Multi-user hosting is `wenilla-realm`, which mounts the
//! same routers behind a session cookie.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use benilla_formats::Chain;
use clap::Parser;

#[derive(Parser)]
#[command(
    about = "Serve the benilla browser build, its game data, and its net proxy (local testing only)",
    after_help = "wenilla-host is for local testing. /data serves the game files under --data to \
                  anyone who can reach the socket, without any login. Keep it on loopback or a \
                  private network; never expose it on the open internet. For hosting players, \
                  use wenilla-realm."
)]
struct Cli {
    /// Address to listen on. Loopback by default; anything else exposes `/data` to that
    /// network unauthenticated (see `--help`).
    #[arg(long, default_value = "127.0.0.1:8090")]
    bind: String,
    /// Directory holding the wasm-bindgen output (`index.html`, `wenilla.js`, `*.wasm`) —
    /// `scripts/web-build.sh`'s `web/dist/`.
    #[arg(long)]
    www: PathBuf,
    /// The vanilla `Data` directory (or a single `.MPQ`) the chain opens — the same one `benilla`
    /// itself reads on the desktop.
    #[arg(long)]
    data: PathBuf,
    /// Host the `/ws/{port}` proxy dials for the allowed ports — the mangos boxes this host
    /// itself runs against, so it defaults to loopback.
    #[arg(long, default_value = "127.0.0.1")]
    upstream: String,
    /// Also serve HTTPS on this port, with a certificate generated for this machine.
    ///
    /// iPhone Safari enables WebGPU only in a secure context. A phone cannot open this
    /// computer's localhost, and `http://<lan-ip>` loads the page and then crashes when the
    /// client asks for a GPU. Pair it with `--bind 0.0.0.0:8090`. Safari warns once
    /// (Advanced → visit this website).
    #[arg(long)]
    tls_port: Option<u16>,
    /// Where the generated certificate is kept so the phone's exception survives a restart.
    #[arg(long, default_value = ".wenilla-tls")]
    tls_dir: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();

    let chain = Arc::new(
        Chain::open(&cli.data).with_context(|| format!("opening {}", cli.data.display()))?,
    );
    tracing::info!(data = %cli.data.display(), "patch chain open");

    let app = wenilla_host::data::router(chain)
        .merge(wenilla_host::ws::router(
            cli.upstream.clone(),
            wenilla_host::ALLOWED_PORTS,
        ))
        .merge(wenilla_host::static_site::router(&cli.www));

    let http_addr: SocketAddr = cli
        .bind
        .parse()
        .with_context(|| format!("parsing --bind {}", cli.bind))?;
    let listener = tokio::net::TcpListener::bind(http_addr)
        .await
        .with_context(|| format!("binding {}", cli.bind))?;
    if !binds_loopback(&listener) {
        tracing::warn!(
            bind = %cli.bind,
            "wenilla-host is a local testing tool: /data serves your game files to anyone who \
             can reach this address, with no login. Do not expose it on the open internet — use \
             wenilla-realm to host players."
        );
    }
    let http_port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(http_addr.port());
    tracing::info!("this computer: http://127.0.0.1:{http_port}/");
    if let Some(tls_port) = cli.tls_port {
        if tls_port == http_port {
            anyhow::bail!("--tls-port {tls_port} is the same as the HTTP port");
        }
        let ips = wenilla_host::tls::listen_ips();
        let cert = wenilla_host::tls::load_or_create(&cli.tls_dir, &["localhost"], &ips)?;
        let config = wenilla_host::tls::rustls_config(&cert).await?;
        let https_addr = SocketAddr::new(http_addr.ip(), tls_port);
        let https = app.clone();
        tokio::spawn(async move {
            if let Err(e) = axum_server::bind_rustls(https_addr, config)
                .serve(https.into_make_service())
                .await
            {
                tracing::error!("https: {e:#}");
            }
        });
        let phones: Vec<_> = ips.into_iter().filter(|ip| !ip.is_loopback()).collect();
        if phones.is_empty() {
            tracing::warn!(
                "no Wi-Fi address found — a phone cannot open this host until this computer is on a network"
            );
        }
        for ip in phones {
            tracing::info!(
                "iPhone (same Wi-Fi): https://{ip}:{tls_port}/  — Safari warns once: tap Advanced, then visit this website"
            );
        }
    }
    tracing::info!(bind = %cli.bind, www = %cli.www.display(), upstream = %cli.upstream, "wenilla-host listening");
    axum::serve(listener, app).await.context("serving")
}

/// Is the listener bound to a loopback address (the only place `/data` is safe unauthenticated)?
fn binds_loopback(listener: &tokio::net::TcpListener) -> bool {
    listener
        .local_addr()
        .map(|a| a.ip().is_loopback())
        .unwrap_or(false)
}
