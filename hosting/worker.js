// Personal play gateway. All origins are fixed; secrets and request cookies never go upstream.
const REPOSITORY = 'WGLewis0721/azeroth-survivors-re';
const COOKIE = '__Host-survivors-play';
const ASSETS = new Map([
  ['mobile.js', 'text/javascript; charset=utf-8'], ['mobile.css', 'text/css; charset=utf-8'],
  ['boot.js', 'text/javascript; charset=utf-8'], ['platform.js', 'text/javascript; charset=utf-8'],
  ['bridge.js', 'text/javascript; charset=utf-8'], ['wasi_stubs.js', 'text/javascript; charset=utf-8'],
  ['favicon.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json'],
  ['boot-manifest.json', 'application/json'], ['world-manifest.json', 'application/json'],
  ['icon-180.png', 'image/png'], ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'],
  ['examples/hud.js', 'text/javascript; charset=utf-8'], ['examples/idle.js', 'text/javascript; charset=utf-8'],
]);
const SECURITY = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...SECURITY, 'Cache-Control': 'private, no-store', ...headers } });
}
function validConfiguration(env) {
  return /^[a-f\d]{40}$/i.test(env.SOURCE_COMMIT ?? '') &&
    /^[A-Za-z\d_.-]{1,128}$/.test(env.RELEASE_TAG ?? '') &&
    /^[a-f\d]{64}$/i.test(env.PLAY_KEY_HASH ?? '');
}
async function authorized(key, expected) {
  // Restrict raw cookie values to portable, unambiguous characters.
  if (typeof key !== 'string' || !/^[A-Za-z\d_-]{16,128}$/.test(key)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  const wanted = Uint8Array.from(expected.match(/../g), byte => parseInt(byte, 16));
  // Workers provides timingSafeEqual. The fallback also avoids early exits for Node tests.
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(digest, wanted);
  let difference = 0;
  for (let i = 0; i < digest.length; i++) difference |= digest[i] ^ wanted[i];
  return difference === 0;
}
function cookieKey(request) {
  const cookies = (request.headers.get('Cookie') ?? '').split(';');
  const matches = cookies.map(c => c.trim()).filter(c => c.startsWith(`${COOKIE}=`));
  return matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : null;
}
async function boundedJson(request) {
  const size = Number(request.headers.get('Content-Length'));
  if (size > 256) throw new Error('large');
  if (!request.body) throw new Error('empty');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256) { await reader.cancel(); throw new Error('large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
const UNLOCK = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#12120f"><title>Azeroth Survivors · Private play</title><style>body{margin:0;background:#080809;color:#eee;font:18px system-ui;min-height:100svh;display:grid;place-items:center}main{max-width:28rem;padding:2rem}h1{font-size:2rem;color:#d9b65c}button,input{font:inherit;width:100%;box-sizing:border-box;padding:16px;border-radius:12px;margin-top:12px}input{background:#202025;color:white;border:1px solid #555}button{background:#d9b65c;border:0;color:#17130b}p{line-height:1.5}#status{min-height:3rem}</style><main><h1>Azeroth Survivors</h1><p>Your private, one-hand adventure.</p><form><label for="key">Play key</label><input id="key" type="password" autocomplete="off" spellcheck="false" required><button>Unlock adventure</button></form><p id="status" role="status">Open your private play link to unlock this device.</p></main><script>const form=document.querySelector('form'),field=document.querySelector('#key'),status=document.querySelector('#status');async function unlock(key){status.textContent='Unlocking…';try{const r=await fetch('/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});if(!r.ok)throw Error();location.replace('/?mobile=1')}catch{status.textContent='That play key did not unlock the game. Open your private link again or enter the key.';form.querySelector('button').disabled=false}}form.addEventListener('submit',e=>{e.preventDefault();form.querySelector('button').disabled=true;unlock(field.value.trim())});const key=new URLSearchParams(location.hash.slice(1)).get('play');if(location.hash)history.replaceState(null,'',location.pathname+location.search);if(key){form.querySelector('button').disabled=true;unlock(key)}</script></html>`;
function route(path, env) {
  const raw = `https://raw.githubusercontent.com/${REPOSITORY}/${env.SOURCE_COMMIT}/web/`;
  if (path === '/' || path === '/index.html') return { url: raw + 'index.html', type: 'text/html; charset=utf-8', html: true };
  const name = path.slice(1);
  if (ASSETS.has(name)) return { url: raw + name, type: ASSETS.get(name) };
  if (path === '/wenilla.js' || path === '/wenilla_bg.wasm') {
    const wasm = path.endsWith('.wasm');
    return { url: `https://github.com/${REPOSITORY}/releases/download/${env.RELEASE_TAG}/${wasm ? 'wenilla_bg.wasm.gz' : 'wenilla.js'}`, type: wasm ? 'application/wasm' : 'text/javascript; charset=utf-8', gzip: wasm };
  }
  if (path.startsWith('/data/')) {
    let name;
    try { name = decodeURIComponent(path.slice(6)).replaceAll('\\', '/').toLowerCase(); } catch { return null; }
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || /[\u0000-\u001f\u007f%?#]/.test(p))) return null;
    return { url: 'https://wow.aethus.pl/data/' + parts.map(encodeURIComponent).join('/'), type: name === '__index' ? 'application/json' : 'application/octet-stream' };
  }
  return null;
}
async function handle(request, env) {
  if (!validConfiguration(env)) return response('Play service is not configured.', 503);
  const url = new URL(request.url);
  if (url.pathname === '/session') {
    if (request.method !== 'POST') return response('Method not allowed', 405, { Allow: 'POST' });
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return response('Forbidden', 403);
    if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return response('JSON required', 415);
    let body;
    try { body = await boundedJson(request); } catch { return response('Invalid or oversized request', 400); }
    if (!await authorized(body?.key, env.PLAY_KEY_HASH)) return response('Invalid play key', 403);
    return response(null, 204, { 'Set-Cookie': `${COOKIE}=${body.key}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
  }
  if (!['GET', 'HEAD'].includes(request.method)) return response('Method not allowed', 405, { Allow: 'GET, HEAD' });
  if (!await authorized(cookieKey(request), env.PLAY_KEY_HASH)) {
    if (url.pathname === '/' || url.pathname === '/index.html') return response(request.method === 'HEAD' ? null : UNLOCK, 200, { 'Content-Type': 'text/html; charset=utf-8' });
    return response(request.method === 'HEAD' ? null : 'Unlock the game first.', 401);
  }
  const destination = route(url.pathname, env);
  if (!destination) return response(request.method === 'HEAD' ? null : 'Not found', 404);
  const headers = new Headers();
  // Only range/validator headers are forwarded. Never forward a cookie, key, origin or referrer.
  for (const name of ['Range', 'If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(name);
    // A partial gzip file cannot be decompressed independently. Always serve complete WASM.
    if (value && !(destination.gzip && name === "Range")) headers.set(name, value);
  }
  const upstream = await fetch(destination.url, { method: request.method, headers, redirect: 'follow' });
  if (![200, 206, 304].includes(upstream.status)) {
    if (upstream.body) await upstream.body.cancel();
    return response(request.method === 'HEAD' ? null : 'Game content is unavailable. Please try again.', upstream.status === 404 ? 404 : 502);
  }
  const outgoing = new Headers(SECURITY);
  outgoing.set('Content-Type', destination.type);
  outgoing.set('Cache-Control', destination.html ? 'private, no-store' : 'private, max-age=86400');
  for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified', 'Accept-Ranges', 'Content-Range']) {
    const value = upstream.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  if (destination.gzip) outgoing.set('Content-Encoding', 'gzip');
  return new Response(request.method === 'HEAD' || upstream.status === 304 ? null : upstream.body, { status: upstream.status, headers: outgoing, encodeBody: "manual" });
}
export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch { return response(request.method === 'HEAD' ? null : 'Play service is temporarily unavailable.', 502); }
  },
};
