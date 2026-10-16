//! Static hosting for the browser build's output directory (`index.html`, `wenilla.js`,
//! `wenilla_bg.wasm`) — everything `scripts/web-build.sh` writes to `web/dist/`.
//!
//! Everything under `--www` gets `no-cache` rather than the immutable long cache the `/data/*`
//! route uses — that directory holds only `index.html`/`wenilla.js`/`wenilla_bg.wasm`,
//! and the wasm bundle changes on every rebuild but keeps the same filename (no content-hash),
//! so a long cache would pin a stale client against a server that has already moved on — dev-
//! cycle friction the `/data/*` files don't have (those are content the game itself never
//! changes).

use std::path::Path;

use axum::http::{HeaderName, HeaderValue};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

pub fn router(www: &Path) -> axum::Router {
    // Outside the header layers, so it sees them already applied and can take them off.
    // `Router::layer` covers the fallback that actually serves the files.
    inner(www).layer(axum::middleware::from_fn(drop_isolation_on_webkit))
}

fn inner(www: &Path) -> axum::Router {
    let no_cache = HeaderValue::from_static("no-cache");
    // Precompressed, not compressed on the fly: the wasm is ~90 MB, and brotli-ing that per
    // request is seconds of CPU for every page load. `scripts/web-build.sh` writes the
    // `.br`/`.gz` siblings once; a browser that accepts neither gets the plain file.
    let serve = ServeDir::new(www)
        .append_index_html_on_directories(true)
        .precompressed_br()
        .precompressed_gzip();
    axum::Router::new().fallback_service(
        tower::ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                axum::http::header::CACHE_CONTROL,
                no_cache,
            ))
            // Cross-origin isolation. Together these two put the page in the state where
            // `SharedArrayBuffer` is constructible and `crossOriginIsolated` is true — the
            // browser's precondition for ever running this client's wasm on more than one
            // thread, and for `performance.measureUserAgentSpecificMemory()`.
            //
            // Groundwork, not a feature: nothing in the tree uses either yet (the client is
            // single-threaded, and `sound/mix_tap.rs` and `sound/probe.rs` say so in as many
            // words). It is here because it is nearly free to be correct about now and
            // genuinely awkward to retrofit later — the headers have to be on the *document*
            // response, and every subresource has to consent.
            //
            // Safe here because the page has no cross-origin subresources at all: `index.html`
            // links nothing external, and the wasm, the glue, `/data/*` and `/ws/*` are all
            // served by this one process on one origin. `require-corp` rather than
            // `credentialless` for that reason — there is nothing to be lenient towards.
            //
            // The cost is real but narrow: COOP `same-origin` severs `window.opener`, so a page
            // that embeds this client in a cross-origin iframe, or opens it as a popup and then
            // talks to it, stops working. Nothing in this repo does either.
            .layer(SetResponseHeaderLayer::overriding(
                HeaderName::from_static("cross-origin-opener-policy"),
                HeaderValue::from_static("same-origin"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                HeaderName::from_static("cross-origin-embedder-policy"),
                HeaderValue::from_static("require-corp"),
            ))
            .service(serve),
    )
}

/// iOS Safari (and iOS Chrome, which is WebKit) kills the tab once a cross-origin-isolated
/// document instantiates this client's wasm and asks for a WebGPU device. Nothing here uses
/// `SharedArrayBuffer` yet — the headers are groundwork — so a WebKit page can play without
/// them. Desktop Chromium keeps the pair; the integration test locks that split.
async fn drop_isolation_on_webkit(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let webkit = request
        .headers()
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(apple_webkit_without_blink);
    let mut response = next.run(request).await;
    if webkit {
        let headers = response.headers_mut();
        headers.remove("cross-origin-opener-policy");
        headers.remove("cross-origin-embedder-policy");
    }
    response
}

/// WebKit, including CriOS and EdgiOS, which do not spell "Chrome". Blink UAs do, and they keep
/// isolation.
fn apple_webkit_without_blink(ua: &str) -> bool {
    let ua = ua.to_ascii_lowercase();
    ua.contains("applewebkit") && !ua.contains("chrome") && !ua.contains("chromium")
}

#[cfg(test)]
mod tests {
    use super::apple_webkit_without_blink;

    #[test]
    fn iphone_safari_and_crios_drop_isolation_and_desktop_chrome_does_not() {
        let safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
        let crios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1";
        let chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        assert!(apple_webkit_without_blink(safari));
        assert!(apple_webkit_without_blink(crios));
        assert!(!apple_webkit_without_blink(chrome));
        assert!(!apple_webkit_without_blink(""));
    }
}
