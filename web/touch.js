// touch.js — a stick and two buttons for a phone, where WASD and F do not exist.
//
// The survivors hero already moves from key state and aims from the cursor
// (`survivors/hero.rs`). A touch on the canvas becomes that cursor through winit's pointer
// events; the stick and the buttons only have to deliver keydown/keyup to the canvas, which is
// where winit listens. The overlay itself ignores hits (`pointer-events: none`) except on the
// controls, so a tap on a menu card or the ground still reaches the game.
//
// Best-effort, like platform.js: a desktop with a mouse never mounts it, and a failure leaves
// the canvas as it was.

const CODE_KEY = {
  KeyW: 'w',
  KeyA: 'a',
  KeyS: 's',
  KeyD: 'd',
  Space: ' ',
  KeyF: 'f',
  Escape: 'Escape',
};

export function phoneLike() {
  const nav = globalThis.navigator;
  if (!nav) return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const iPadDesktop = nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1;
  if (/iPhone|iPad|iPod/i.test(nav.userAgent || '') || iPadDesktop) return true;
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function installTouchControls() {
  if (!phoneLike()) return false;
  const canvas = document.getElementById('benilla');
  if (!canvas) return false;

  const root = document.createElement('div');
  root.id = 'wenilla-touch';
  root.style.cssText =
    'position:fixed;inset:0;z-index:12;pointer-events:none;' +
    'font:14px system-ui,sans-serif;user-select:none;-webkit-user-select:none;touch-action:none';

  const down = new Set();
  const setKey = (code, pressed) => {
    if (pressed === down.has(code)) return;
    if (pressed) down.add(code);
    else down.delete(code);
    canvas.dispatchEvent(
      new KeyboardEvent(pressed ? 'keydown' : 'keyup', {
        code,
        key: CODE_KEY[code] || code,
        bubbles: true,
        cancelable: true,
      })
    );
  };
  const releaseAll = () => {
    for (const code of [...down]) setKey(code, false);
  };

  const stick = document.createElement('div');
  stick.style.cssText =
    'position:absolute;left:calc(1.1rem + env(safe-area-inset-left));' +
    'bottom:calc(1.2rem + env(safe-area-inset-bottom));width:128px;height:128px;' +
    'border-radius:50%;border:1px solid #6b5426;background:rgba(0,0,0,.35);pointer-events:auto';
  const knob = document.createElement('div');
  knob.style.cssText =
    'position:absolute;left:44px;top:44px;width:40px;height:40px;border-radius:50%;background:#e9dcb8';
  stick.appendChild(knob);
  const resetKnob = () => {
    knob.style.left = '44px';
    knob.style.top = '44px';
  };
  let stickPointer = null;
  stick.addEventListener('pointerdown', (e) => {
    stickPointer = e.pointerId;
    stick.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    aimStick(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickPointer) return;
    e.preventDefault();
    aimStick(e);
  });
  const endStick = (e) => {
    if (e.pointerId !== stickPointer) return;
    stickPointer = null;
    e.preventDefault();
    resetKnob();
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) setKey(code, false);
  };
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);

  function aimStick(e) {
    const box = stick.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const limit = box.width / 2 - 20;
    const len = Math.hypot(dx, dy) || 1;
    const scale = Math.min(1, limit / len);
    dx *= scale;
    dy *= scale;
    knob.style.left = `${44 + dx}px`;
    knob.style.top = `${44 + dy}px`;
    const dead = box.width * 0.18;
    setKey('KeyA', dx < -dead);
    setKey('KeyD', dx > dead);
    setKey('KeyW', dy < -dead);
    setKey('KeyS', dy > dead);
  }

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:absolute;right:calc(1.1rem + env(safe-area-inset-right));' +
    'bottom:calc(1.2rem + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:.6rem';
  for (const [label, code] of [
    ['Jump', 'Space'],
    ['Spell', 'KeyF'],
    ['Pause', 'Escape'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText =
      'pointer-events:auto;min-width:5.5rem;padding:.7rem .8rem;border-radius:999px;' +
      'border:1px solid #6b5426;background:rgba(0,0,0,.55);color:#e9dcb8;font:inherit';
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      button.setPointerCapture?.(e.pointerId);
      setKey(code, true);
    });
    const up = (e) => {
      e.preventDefault();
      setKey(code, false);
    };
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    bar.appendChild(button);
  }

  globalThis.addEventListener?.('blur', releaseAll);
  root.append(stick, bar);
  document.body.appendChild(root);
  return true;
}
