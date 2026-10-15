import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const source = await readFile(new URL('./worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const KEY = 'synthetic-test-key-0123456789';
const env = { SOURCE_COMMIT: 'a'.repeat(40), RELEASE_TAG: 'mobile-v1-test', PLAY_KEY_HASH: createHash('sha256').update(KEY).digest('hex') };
const cookie = `__Host-survivors-play=${KEY}`;
const originalFetch = globalThis.fetch;
const request = (path, init = {}) => new Request('https://play.example' + path, init);
const authenticated = (path, init = {}) => request(path, { ...init, headers: { Cookie: cookie, ...init.headers } });
function mockFetch(fn) { globalThis.fetch = fn; }
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('unauthenticated root is a mobile unlock form; private routes never contact upstream', async () => {
  mockFetch(() => assert.fail('private asset leaked upstream'));
  const root = await worker.fetch(request('/'), env);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('Cache-Control'), 'private, no-store');
  const page = await root.text();
  assert.match(page, /name="viewport"/);
  assert.match(page, /history\.replaceState/);
  assert.match(page, /fetch\('\/session'/);
  assert.ok(!page.includes(KEY));
  for (const path of ['/wenilla_bg.wasm', '/mobile.js', '/data/__index', '/data/world%5Cmaps%5Cfoo.adt']) {
    assert.equal((await worker.fetch(request(path), env)).status, 401);
  }
});

test('session validates the digest and sets a secure host-only HTTP-only cookie', async () => {
  const result = await worker.fetch(request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://play.example' }, body: JSON.stringify({ key: KEY }) }), env);
  assert.equal(result.status, 204);
  const header = result.headers.get('Set-Cookie');
  for (const expected of [cookie, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(header.includes(expected));
  assert.ok(!header.includes('Domain='));
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
});

test('session rejects wrong keys, cross-origin submissions, invalid JSON and unsupported methods', async () => {
  for (const [init, expected] of [
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'wrong-key-0123456789' }) }, 403],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }, body: JSON.stringify({ key: KEY }) }, 403],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400],
    [{ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: KEY }, 415],
    [{ method: 'GET' }, 405],
  ]) assert.equal((await worker.fetch(request('/session', init), env)).status, expected);
});

test('session enforces its body limit even with no Content-Length', async () => {
  let cancelled = false;
  let count = 0;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(200)); count++; }, cancel() { cancelled = true; } });
  const result = await worker.fetch(request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' }), env);
  assert.equal(result.status, 400);
  assert.equal(cancelled, true);
  assert.ok(count < 5);
  assert.equal((await worker.fetch(request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '257' }, body: '{}' }), env)).status, 400);
});

test('authenticated HTML is pinned to the configured commit and never caches privately served HTML', async () => {
  mockFetch(async (url, init) => {
    assert.equal(url, `https://raw.githubusercontent.com/WGLewis0721/azeroth-survivors-re/${env.SOURCE_COMMIT}/web/index.html`);
    assert.equal(init.headers.get('Cookie'), null);
    return new Response('<html>game</html>', { headers: { 'Content-Type': 'text/plain', 'Set-Cookie': 'upstream=bad' } });
  });
  const result = await worker.fetch(authenticated('/?mobile=1'), env);
  assert.equal(result.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(await result.text(), '<html>game</html>');
});

test('known static assets have browser MIME types and revalidate across deployments', async () => {
  mockFetch(async () => new Response('asset', { headers: { 'Content-Type': 'text/plain' } }));
  for (const [path, type] of [ ['/mobile.js', 'text/javascript; charset=utf-8'], ['/mobile.css', 'text/css; charset=utf-8'], ['/manifest.webmanifest', 'application/manifest+json'], ['/boot-manifest.json', 'application/json'], ['/world-manifest.json', 'application/json'], ['/icon-180.png', 'image/png'] ]) {
    const result = await worker.fetch(authenticated(path), env);
    assert.equal(result.headers.get('Content-Type'), type);
    assert.equal(result.headers.get('Cache-Control'), 'private, max-age=0, must-revalidate');
  }
});

test('WASM release bytes are streamed as gzip with the compressed length preserved', async () => {
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const compressed = gzipSync(wasm);
  mockFetch(async (url, init) => {
    assert.equal(url, `https://github.com/WGLewis0721/azeroth-survivors-re/releases/download/${env.RELEASE_TAG}/wenilla_bg.wasm.gz`);
    assert.equal(init.headers.get('Cookie'), null);
    assert.equal(init.headers.get('Range'), null);
    return new Response(compressed, { headers: { 'Content-Length': String(compressed.length) } });
  });
  const result = await worker.fetch(authenticated('/wenilla_bg.wasm', { headers: { Range: 'bytes=10-40' } }), env);
  assert.equal(result.headers.get('Content-Type'), 'application/wasm');
  assert.equal(result.headers.get('Content-Encoding'), 'gzip');
  assert.equal(result.headers.get('Content-Length'), String(compressed.length));
  assert.deepEqual(gunzipSync(Buffer.from(await result.arrayBuffer())), wasm);
});

test('data paths normalize WoW backslashes and casing without forwarding credentials', async () => {
  mockFetch(async (url, init) => {
    assert.equal(url, 'https://wow.aethus.pl/data/world/maps/test%20map/test_1_2.adt');
    assert.equal(init.headers.get('Cookie'), null);
    assert.equal(init.headers.get('Authorization'), null);
    assert.equal(init.headers.get('Referer'), null);
    assert.equal(init.headers.get('Range'), 'bytes=0-9');
    return new Response('0123456789', { status: 206, headers: { 'Content-Range': 'bytes 0-9/100' } });
  });
  const result = await worker.fetch(authenticated('/data/World%5CMaps%5CTest%20Map%5CTest_1_2.adt', { headers: { Authorization: 'Bearer private', Referer: 'https://play.example/#secret', Range: 'bytes=0-9' } }), env);
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('Content-Range'), 'bytes 0-9/100');
  assert.equal(await result.text(), '0123456789');
});

test('data index has JSON MIME; HEAD proxies with no response body', async () => {
  mockFetch(async (url, init) => {
    assert.equal(url, 'https://wow.aethus.pl/data/__index');
    assert.equal(init.method, 'HEAD');
    return new Response(null, { headers: { 'Content-Length': '1600000' } });
  });
  const result = await worker.fetch(authenticated('/data/__index', { method: 'HEAD' }), env);
  assert.equal(result.headers.get('Content-Type'), 'application/json');
  assert.equal(result.headers.get('Content-Length'), '1600000');
  assert.equal(await result.text(), '');
});

test('rejects traversal, malformed encoding and unknown paths without an upstream request', async () => {
  mockFetch(() => assert.fail('invalid route contacted upstream'));
  for (const path of ['/data/World%5C..%5Csecret', '/data/%252e%252e%252fsecret', '/data/%ZZ', '/data/a%00b', '/data//foo', '/secret', '/examples/unknown.js', '/icon-other.png']) {
    assert.equal((await worker.fetch(authenticated(path), env)).status, 404, path);
  }
  assert.equal((await worker.fetch(authenticated('/mobile.js', { method: 'DELETE' }), env)).status, 405);
});

test('invalid or duplicate cookies fail closed; missing deployment bindings fail closed', async () => {
  mockFetch(() => assert.fail('unauthorized route contacted upstream'));
  for (const value of [`${cookie}; ${cookie}`, '__Host-survivors-play=wrong-key-0123456789', 'another=token']) {
    assert.equal((await worker.fetch(request('/mobile.js', { headers: { Cookie: value } }), env)).status, 401);
  }
  assert.equal((await worker.fetch(request('/'), { ...env, PLAY_KEY_HASH: '' })).status, 503);
  assert.equal((await worker.fetch(authenticated('/'), { ...env, SOURCE_COMMIT: '../main' })).status, 503);
});

test('upstream errors never leak upstream bodies or secrets', async () => {
  mockFetch(async () => new Response('private upstream diagnostics', { status: 500 }));
  const failed = await worker.fetch(authenticated('/mobile.js'), env);
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes('diagnostics'));
  mockFetch(async () => { throw new Error('sensitive network details'); });
  const thrown = await worker.fetch(authenticated('/wenilla.js'), env);
  assert.equal(thrown.status, 502);
  assert.ok(!(await thrown.text()).includes('sensitive'));
});


test('hosted terrain configuration is private and selects a supplied starting zone', async () => {
  mockFetch(() => assert.fail('configuration must not contact upstream'));
  assert.equal((await worker.fetch(request('/play-config.json'), env)).status, 401);
  const r = await worker.fetch(authenticated('/play-config.json'), env);
  const config = await r.json();
  assert.equal(config.startMap, 'Elwynn Forest');
  assert.ok(config.allowedMaps.includes(config.startMap));
  assert.ok(!config.allowedMaps.includes('The Barrens'));
});


test('runtime build branch is pinned to its own immutable commit', async () => {
  const runtime = 'b'.repeat(40);
  mockFetch(async (url) => {
    assert.equal(url, `https://raw.githubusercontent.com/WGLewis0721/azeroth-survivors-re/${runtime}/wenilla.js`);
    return new Response('runtime');
  });
  const r = await worker.fetch(authenticated('/wenilla.js'), { ...env, RELEASE_TAG: undefined, RUNTIME_COMMIT: runtime });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'runtime');
});


test('generated wasm-bindgen helpers come from the same runtime commit', async () => {
  const runtime='b'.repeat(40);
  mockFetch(async (url) => {
    assert.equal(url, `https://raw.githubusercontent.com/WGLewis0721/azeroth-survivors-re/${runtime}/snippets/benilla-app-123/inline0.js`);
    return new Response('export function begin() {}');
  });
  const r=await worker.fetch(authenticated('/snippets/benilla-app-123/inline0.js'),{...env,RUNTIME_COMMIT:runtime});
  assert.equal(r.status,200);
  assert.equal(r.headers.get('Content-Type'),'text/javascript; charset=utf-8');
});
