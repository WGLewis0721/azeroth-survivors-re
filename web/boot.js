// boot.js — the pre-login loading experience.
// On mobile (iOS Safari) the parallel data prefetch + streaming compile spikes memory
// and kills the process before the client can apply low render settings.

const BR_RATIO = 5.0;
const READY_TIMEOUT_MS = 20000;
const PREFETCH_CONCURRENCY = 8;

const isMobile = () =>
  (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ||
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  new URLSearchParams(location.search).get('mobile') === '1';

export async function boot(init, opts = {}) {
  const q = new URLSearchParams(location.search);
  const mobile = isMobile();
  const ui = createBootUi();
  if (q.get('boottrace') === '1') window.__wenilla_boottrace = [];
  // Mobile: skip prefetch entirely. Concurrent data + WASM compile OOMs iOS Safari.
  const skipPrefetch = mobile || q.get('boottrace') === '1' || q.get('noprefetch') === '1';
  installProgressHook(ui, skipPrefetch);

  const prefetch = skipPrefetch
    ? Promise.resolve()
    : prefetchManifest('./boot-manifest.json', (done, total) => ui.setData(done, total)).catch(
        () => ui.setData(0, 0)
      );

  const wasm = loadClientModule((got, total) => ui.setWasmProgress(got, total), mobile);
  let w;
  try {
    const [module] = await Promise.all([wasm, prefetch]);
    w = await init({ module_or_path: module });
  } catch (e) {
    ui.fail('The client failed to start: ' + (e && e.message ? e.message : e));
    throw e;
  }
  ui.setStage('Starting…');
  ui.armTimeout(opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  return w;
}


const SPLIT_PARTS = [
  './snippets/wenilla-s0/inline0.js',
  './snippets/wenilla-s1/inline0.js',
  './snippets/wenilla-s2/inline0.js',
];

// Each part is gzip, compiled alone, then linked before start. The Worker already
// serves /snippets/*/inline0.js from the runtime commit, so this needs no new route.
// Anything that is not gzip is a normal single-module build.
async function loadClientModule(onBytes, mobile) {
  globalThis.__wenilla_secondaries = await compileSplitParts(onBytes);
  const url = new URL('./wenilla_bg.wasm', import.meta.url);
  return mobile ? compileWasmPlain(url, onBytes) : compileWasm(url, onBytes);
}

async function compileSplitParts(onBytes) {
  const first = await fetch(new URL(SPLIT_PARTS[0], import.meta.url));
  if (!first.ok) return undefined;
  const firstBuf = await first.arrayBuffer();
  if (!isGzip(firstBuf)) return undefined;
  const modules = [];
  let bytes = await gunzip(firstBuf);
  onBytes(bytes.byteLength, bytes.byteLength);
  modules.push(await WebAssembly.compile(bytes));
  for (const name of SPLIT_PARTS.slice(1)) {
    const response = await fetch(new URL(name, import.meta.url));
    if (!response.ok) throw new Error(`Client part failed (HTTP ${response.status})`);
    bytes = await gunzip(await response.arrayBuffer());
    onBytes(bytes.byteLength, bytes.byteLength);
    modules.push(await WebAssembly.compile(bytes));
  }
  return modules;
}

function isGzip(buf) {
  const bytes = new Uint8Array(buf);
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// Mobile path: download fully, then compile. Avoids the counting-stream + compileStreaming
// double-buffer that OOMs iOS during instantiation.
async function compileWasmPlain(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Client download failed (HTTP ${r.status})`);
  const buf = await r.arrayBuffer();
  onBytes(buf.byteLength, buf.byteLength);
  return WebAssembly.compile(buf);
}

async function compileWasm(url, onBytes) {
  const response = await fetchWasm(url, onBytes);
  if (!response.ok) throw new Error(`Client download failed (HTTP ${response.status})`);
  if (typeof WebAssembly.compileStreaming === 'function' &&
      response.headers.get('content-type')?.trim().toLowerCase() === 'application/wasm') {
    return WebAssembly.compileStreaming(response);
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

async function fetchWasm(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok || !r.body) return r;
  const contentLength = Number(r.headers.get('content-length')) || 0;
  const compressed = !!(r.headers.get('content-encoding') || '').trim();
  const total = contentLength ? contentLength * (compressed ? BR_RATIO : 1) : 0;
  let got = 0;
  const reader = r.body.getReader();
  const counted = new ReadableStream({
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) {
        onBytes(got, got);
        c.close();
        return;
      }
      got += value.byteLength;
      onBytes(got, total);
      c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(counted, { status: r.status, statusText: r.statusText, headers: r.headers });
}

async function prefetchManifest(manifestUrl, onProgress) {
  const r = await fetch(manifestUrl);
  if (!r.ok) return onProgress(0, 0);
  const manifest = await r.json();
  const names = Array.isArray(manifest && manifest.names) ? manifest.names : [];
  if (!names.length) return onProgress(0, 0);
  let done = 0;
  onProgress(0, names.length);
  const queue = names.slice();
  async function worker() {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      try {
        const resp = await fetch('/data/' + encodeURIComponent(name));
        if (resp.ok) await resp.arrayBuffer();
      } catch (_) {}
      done += 1;
      onProgress(done, names.length);
    }
  }
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
}

function installProgressHook(ui, skipPrefetch) {
  window.__wenilla_progress = (stage) => {
    if (stage === 'startup') ui.setStage('Raising the world…');
    else if (stage === 'ready') {
      ui.hide();
      if (!skipPrefetch) {
        const corner = createCornerLine();
        prefetchManifest('./world-manifest.json', (done, total) =>
          corner.set(total > 0 && done < total ? `preparing world data — ${done}/${total}` : '')
        )
          .catch(() => {})
          .finally(() => corner.remove());
      }
    }
  };
}

function createCornerLine() {
  const el = document.createElement('div');
  el.id = 'wenilla-corner';
  el.style.cssText =
    'position:fixed;left:.6rem;bottom:.5rem;z-index:15;font:12px system-ui,sans-serif;' +
    'color:#888;background:rgba(0,0,0,.55);padding:.2rem .5rem;border-radius:4px;' +
    'pointer-events:none;transition:opacity .4s ease';
  document.body.appendChild(el);
  return {
    set(text) {
      el.textContent = text;
      el.style.opacity = text ? '1' : '0';
    },
    remove() {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    },
  };
}

function createBootUi() {
  const root = document.createElement('div');
  root.id = 'wenilla-boot';
  root.innerHTML = `
    <style>
      #wenilla-boot { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center;
        color: #d8c9a3; font: 14px Georgia, serif; overflow: hidden; background: #070504;
        transition: opacity .6s ease; }
      #wenilla-boot.gone { opacity: 0; pointer-events: none; }
      #wenilla-boot .box { position: relative; width: min(620px, 86vw); text-align: center; }
      #wenilla-boot .title { font: 48px/1.1 Georgia, serif; color: #ffd25a; }
      #wenilla-boot .by { margin: 1rem 0 2rem; font-size: 13px; color: #a8956b; }
      #wenilla-boot .stage { margin-bottom: .7rem; min-height: 1.2em; color: #e9dcb8; }
      #wenilla-boot .bar { position: relative; height: 10px; border: 1px solid #6b5426; border-radius: 6px;
        background: #1d140a; overflow: hidden; width: min(460px, 82vw); margin: 0 auto; }
      #wenilla-boot .bar > i { display: block; height: 100%; width: 0; background: #e0631c; transition: width .2s linear; }
      #wenilla-boot .data { margin-top: .6rem; font-size: 12px; color: #8a7a5c; min-height: 1.2em; }
      #wenilla-boot .tip { margin-top: 2rem; font-size: 14px; color: #c8b68a; min-height: 2.6em; font-style: italic; }
      #wenilla-boot .err { color: #ff7a6a; }
    </style>
    <div class="box">
      <div class="title">Azeroth Survivors</div>
      <div class="by">a fan-made roguelike by Aethus</div>
      <div class="stage">Loading…</div>
      <div class="bar"><i></i></div>
      <div class="data"></div>
      <div class="tip"></div>
    </div>`;
  const tips = [
    'Your spells cast themselves. Your only job is to not die.',
    'Gems pull toward you once you are close.',
    'A boss arrives every couple of minutes.',
  ];
  const tipEl = root.querySelector('.tip');
  let tipN = Math.floor(Math.random() * tips.length);
  tipEl.textContent = tips[tipN];
  const tipTimer = setInterval(() => {
    tipN = (tipN + 1) % tips.length;
    tipEl.textContent = tips[tipN];
  }, 5000);
  document.body.appendChild(root);
  const stageEl = root.querySelector('.stage');
  const barEl = root.querySelector('.bar');
  const fillEl = root.querySelector('.bar > i');
  const dataEl = root.querySelector('.data');
  let gone = false;
  let timeout = 0;
  const mb = (n) => (n / (1024 * 1024)).toFixed(0);
  return {
    setWasmProgress(got, total) {
      if (gone) return;
      if (total > 0) {
        const pct = Math.min(99, Math.floor((got / total) * 100));
        const done = got >= total;
        stageEl.textContent = done ? 'Summoning the horde…' : `Downloading the client — ${pct}%`;
        fillEl.style.width = (done ? 100 : pct) + '%';
      } else {
        stageEl.textContent = `Downloading client — ${mb(got)} MB`;
      }
    },
    setData(done, total) {
      if (gone) return;
      dataEl.textContent = total > 0 && done < total ? `warming game data ${done} / ${total}` : '';
    },
    setStage(text) {
      if (gone) return;
      stageEl.textContent = text;
    },
    fail(text) {
      clearTimeout(timeout);
      barEl.remove();
      dataEl.remove();
      clearInterval(tipTimer);
      stageEl.className = 'err';
      stageEl.textContent = text;
    },
    armTimeout(ms) {
      timeout = setTimeout(() => this.hide(), ms);
    },
    hide() {
      if (gone) return;
      gone = true;
      clearTimeout(timeout);
      clearInterval(tipTimer);
      root.classList.add('gone');
      setTimeout(() => root.remove(), 700);
    },
  };
}
