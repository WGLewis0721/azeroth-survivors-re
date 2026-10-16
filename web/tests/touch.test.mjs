import assert from 'node:assert/strict';
import test from 'node:test';

import { installTouchControls, phoneLike } from '../touch.js';

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

function element(tag) {
  return {
    tag,
    style: {},
    children: [],
    listeners: {},
    textContent: '',
    type: '',
    setAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 128, height: 128 }; },
  };
}

test('a desktop mouse does not mount controls', t => {
  withGlobals(t, {
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120.0.0.0', platform: 'MacIntel', maxTouchPoints: 0 },
    matchMedia: () => ({ matches: false }),
  });
  assert.equal(phoneLike(), false);
  assert.equal(installTouchControls(), false);
});

test('the stick holds W while the thumb is above centre and releases it', t => {
  const canvas = { events: [], dispatchEvent(ev) { this.events.push(ev); } };
  const body = element('body');
  const document = {
    getElementById(id) { return id === 'benilla' ? canvas : null; },
    createElement: element,
    body,
  };
  class KeyboardEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  withGlobals(t, {
    navigator: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    },
    document,
    KeyboardEvent,
  });
  assert.equal(installTouchControls(), true);
  const stick = body.children[0].children[0];
  const fire = (type, x, y, pointerId = 1) => {
    const event = { type, clientX: x, clientY: y, pointerId, preventDefault() {} };
    for (const fn of stick.listeners[type]) fn(event);
  };
  fire('pointerdown', 64, 10);
  assert.deepEqual(canvas.events.map(e => [e.type, e.code]), [['keydown', 'KeyW']]);
  fire('pointermove', 64, 64);
  assert.deepEqual(canvas.events.map(e => [e.type, e.code]), [['keydown', 'KeyW'], ['keyup', 'KeyW']]);
  fire('pointerup', 64, 64);
  assert.equal(canvas.events.filter(e => e.type === 'keydown' && e.code === 'KeyW').length, 1);
});
