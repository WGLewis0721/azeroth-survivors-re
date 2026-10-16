import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capDevicePixelRatio,
  installPointerLockShim,
  isIOS,
  phoneSessionEnv,
  webgpuBlockedReason,
} from '../safari.js';

function withGlobals(t, values) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

test('an iPhone is detected and a desktop Chrome is not', t => {
  withGlobals(t, { navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1', platform: 'iPhone', maxTouchPoints: 5 } });
  assert.equal(isIOS(), true);
  assert.deepEqual(phoneSessionEnv(), { renderscale: '0.75', render_scale: '0.75', farclip: '220' });
});

test('a desktop session keeps full resolution and the default view distance', t => {
  withGlobals(t, {
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0', platform: 'MacIntel', maxTouchPoints: 0 },
    matchMedia: () => ({ matches: false }),
  });
  assert.equal(isIOS(), false);
  assert.deepEqual(phoneSessionEnv(), {});
});

test('pointer lock that throws does not escape the shim', t => {
  const document = {
    exitPointerLock() { throw new TypeError('exitPointerLock is not a function'); },
  };
  withGlobals(t, { document, Element: undefined });
  installPointerLockShim();
  assert.doesNotThrow(() => document.exitPointerLock());
});

test('devicePixelRatio above 2 is capped so the canvas stays inside phone GPU limits', t => {
  const window = {};
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 3 });
  withGlobals(t, { window });
  assert.equal(capDevicePixelRatio(2), 2);
  assert.equal(window.devicePixelRatio, 2);
});

test('plain http on a phone is refused before the client boots', t => {
  withGlobals(t, { isSecureContext: false, navigator: { gpu: {} } });
  assert.match(webgpuBlockedReason(), /https:\/\//);
});

test('a secure page with WebGPU is allowed to boot', t => {
  withGlobals(t, { isSecureContext: true, navigator: { gpu: {} } });
  assert.equal(webgpuBlockedReason(), '');
});

test('a secure page without WebGPU names Safari 26', t => {
  withGlobals(t, { isSecureContext: true, navigator: {} });
  assert.match(webgpuBlockedReason(), /Safari 26/);
});
