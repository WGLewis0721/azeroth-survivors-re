// safari.js — what iPhone Safari does to this page that desktop Chrome does not.
//
// The tab dies after the load bar finishes, for three independent reasons:
//
//   1. WebGPU exists only in a secure context. `localhost` is one; the phone's localhost is
//      the phone, and `http://<this computer's Wi-Fi address>` is not secure. The wasm still
//      boots, then wgpu aborts while creating the device. `make start` prints an https URL
//      for that address; until the page is opened there, refuse to boot instead of crashing.
//   2. `document.exitPointerLock` is missing or throws. winit calls it while the window is
//      created, the binding is not `catch`, and the wasm trap takes the tab down
//      (bevyengine/bevy#21497). Bevy 0.18 skips the call when the function is absent; a build
//      where the function exists and throws still traps. A wrapper that never throws covers both.
//   3. Without a viewport meta the layout viewport is ~980 CSS px, and winit multiplies that by
//      `devicePixelRatio` (3 on a phone). The canvas then exceeds the GPU's max texture edge
//      and the WebGPU process is killed. The meta tag is in index.html; this file also caps
//      the ratio, because a 3× HDR target is enough memory for iOS to jetsam the tab once the
//      world starts drawing.

export function userAgent() {
  return (globalThis.navigator && navigator.userAgent) || '';
}

export function isIOS() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  const iPadDesktop = nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1;
  return /iPhone|iPad|iPod/i.test(nav.userAgent || '') || iPadDesktop;
}

export function isWebKit() {
  const ua = userAgent();
  return /AppleWebKit/i.test(ua) && !/Chrome|Chromium/i.test(ua);
}

function coarsePointer() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/// A handset: iOS, or any browser that has no mouse. Desktop is left alone.
export function phoneLike() {
  return isIOS() || coarsePointer();
}

/// Replace pointer-lock entry points with ones that cannot throw into wasm.
export function installPointerLockShim() {
  const doc = document;
  const origExit = typeof doc.exitPointerLock === 'function' ? doc.exitPointerLock.bind(doc) : null;
  doc.exitPointerLock = () => {
    try {
      if (origExit) origExit();
    } catch (_) {
      /* missing or refused: the cursor stays free, the game keeps running */
    }
  };
  const proto = typeof Element === 'function' ? Element.prototype : null;
  if (!proto) return;
  const origLock = proto.requestPointerLock;
  proto.requestPointerLock = function (...args) {
    if (typeof origLock !== 'function') {
      return Promise.reject(new DOMException('Pointer lock is not supported', 'NotSupportedError'));
    }
    try {
      const result = origLock.apply(this, args);
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return result;
    } catch (e) {
      return Promise.reject(e);
    }
  };
}

/// Cap `window.devicePixelRatio` so winit's canvas backing store stays inside phone GPU limits.
/// Returns the ratio the page will actually observe.
export function capDevicePixelRatio(max = 2) {
  const real = window.devicePixelRatio || 1;
  if (!(real > max)) return real;
  try {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      get: () => max,
    });
  } catch (_) {
    /* a non-configurable getter keeps the real ratio; the viewport meta still bounds CSS size */
  }
  return window.devicePixelRatio || real;
}

/// Session CVars for a phone. `renderscale` is the cvar (`WOW_renderScale`); `render_scale` is
/// what `RenderScale`'s default reads (`WOW_RENDER_SCALE`). `farclip` is applied from the page
/// env at startup. Empty on a desktop, so a mouse session is unchanged.
export function phoneSessionEnv() {
  if (!phoneLike()) return {};
  return { renderscale: '0.75', render_scale: '0.75', farclip: '220' };
}

function secureContext() {
  if (typeof globalThis.isSecureContext === 'boolean') return globalThis.isSecureContext;
  return !!globalThis.window?.isSecureContext;
}

/// Why booting would crash, or `''` when WebGPU can come up.
export function webgpuBlockedReason() {
  if (!secureContext()) {
    return 'This page is not a secure page, so the browser will not enable WebGPU and the game stops as soon as it finishes loading. On this computer open http://127.0.0.1:8090. On your iPhone, join the same Wi-Fi and open the https:// address that `make start` prints, then tap Advanced and visit this website.';
  }
  if (!globalThis.navigator || !navigator.gpu) {
    return 'This browser has no WebGPU, so the world cannot start. An iPhone needs Safari 26 or newer.';
  }
  return '';
}

/// Full-screen explanation, used instead of booting when [`webgpuBlockedReason`] is set.
/// Same dark page as the boot overlay, without downloading the client first.
export function showBlocked(reason) {
  const root = document.createElement('div');
  root.id = 'wenilla-safari';
  root.style.cssText =
    'position:fixed;inset:0;z-index:30;display:grid;place-items:center;padding:1.5rem;' +
    'background:#070504;color:#e9dcb8;font:16px Georgia,serif;text-align:center';
  const p = document.createElement('p');
  p.style.cssText = 'max-width:34rem;line-height:1.45;margin:0';
  p.textContent = reason;
  root.appendChild(p);
  document.body.appendChild(root);
}
