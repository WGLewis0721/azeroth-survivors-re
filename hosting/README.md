# Private phone play gateway

`worker.js` runs the mobile build behind a personal HTTPS link. It serves the page from a
pinned commit, streams the matching compiled client from an immutable build commit or GitHub release, and maps the
client's `/data/<encoded WoW path>` requests to the original game's public static data host.
The gateway does not store game data or expose a local `wenilla-host` server.

Required Worker bindings:

- `SOURCE_COMMIT`: full commit SHA in this repository containing the mobile page files.
- `RUNTIME_COMMIT`: full SHA of the separate `iphone-runtime` build branch containing
  `wenilla.js`, `wenilla_bg.wasm.gz` and the generated `snippets/` directory, built together by the Cargo.lock-pinned wasm-bindgen.
  Alternatively, `RELEASE_TAG` can name a GitHub release with those same files.
- `PLAY_KEY_HASH`: secret binding containing the SHA-256 hex digest of a random play key.

The key must be 16–128 URL-safe characters. Generate it with a cryptographic random generator.
A private link uses `/#play=<key>`. The unlock page removes the fragment, posts the key to
`/session`, and sets a Secure, HttpOnly, host-only, SameSite=Lax cookie for 30 days. Raw keys
are not included in source, forwarded upstream or written to application logs. The Worker
must be served over HTTPS. Keep the private link outside the public repository.

The host supplies `/play-config.json` before the WASM client starts. Its map list is restricted
to zones whose starting terrain is present in the upstream static data index: Gates of
Ahn'Qiraj, Gurubashi Arena, Elwynn Forest, Westfall and Duskwood. A new hosted selection starts
in Elwynn. An existing supported saved selection is preserved. Local builds without this
optional route keep the full original map catalog and load their own supplied game data.
The source map indices are retained even when the displayed list is filtered.

The playable client requires Safari on iOS 26+ with WebGPU. The gateway does not provide an
older-iOS renderer. Availability depends on the original data host and its request limits;
this is a personal preview rather than an independent distribution of WoW data.

To create runtime release files, use the existing `scripts/web-build.sh` and gzip the
resulting `web/dist/wenilla_bg.wasm` into `wenilla_bg.wasm.gz`. Publish that file and
`web/dist/wenilla.js` and `web/dist/snippets/` on a separate runtime branch and pin its full commit SHA, or upload them
to the configured release. Deploy the module with today's compatibility
date and the bindings above, then enable its workers.dev subdomain. Keep compiled files off the source branch. Never commit game data or credentials. JavaScript/MIME types, gzip bytes and response streaming are
handled by the gateway; browser data requests are cached privately while client files
revalidate across deployments.

Run gateway boundary tests with `node --test hosting/worker.test.mjs`. The mobile DOM fixture
in `web/tests/mobile-browser.py` also checks filtered map indices. Those tests do not replace
a real WebGPU world-boot and touch-control check of the deployed release.
