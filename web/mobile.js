// A DOM interface over the survivors ECS bridge; no synthetic keyboard events.
export function stickVector(dx, dy, radius = 56, deadzone = 0.12) {
  if (![dx, dy, radius, deadzone].every(Number.isFinite) || radius <= 0 || deadzone < 0 || deadzone >= 1) return { x: 0, y: 0 };
  const distance = Math.hypot(dx, dy);
  const magnitude = Math.min(1, distance / radius);
  if (magnitude <= deadzone || distance === 0) return { x: 0, y: 0 };
  const speed = (magnitude - deadzone) / (1 - deadzone);
  return { x: dx / distance * speed, y: dy / distance * speed };
}

export function wantsMobile(search, coarse) {
  const override = new URLSearchParams(search).get('mobile');
  return override === '1' || (override !== '0' && coarse);
}

export function configureMobile(env, search) {
  const query = new URLSearchParams(search);
  // Aggressive low-memory defaults for iOS Safari. Higher values crash the process during WebGPU/WASM init.
  for (const [name, value] of Object.entries({ renderscale: '0.4', farclip: '100', worlddetail: '0' })) {
    if (!(name in env) && ![...query.keys()].some(key => key.toLowerCase() === name)) env[name] = value;
  }
  return env;
}

export function mountMobile() {
  if (!wantsMobile(location.search, matchMedia('(pointer: coarse)').matches)) return null;
  document.documentElement.classList.add('survivors-mobile');
  const input = window.__survivorsMobileInput = {
    startMap: window.__survivorsHosting?.startMap, allowedMaps: window.__survivorsHosting?.allowedMaps,
    active: true, x: 0, y: 0, action: '', index: 0, sequence: 0, pauseSequence: 0, hidden: document.hidden,
  };
  window.__wenilla_env = configureMobile(window.__wenilla_env ?? {}, location.search);
  const root = document.createElement('div');
  root.id = 'mobile-ui';
  root.innerHTML = `
    <div class="m-hud" hidden>
      <div class="m-status"><span data-time>00:00</span><span data-level>Level 1</span><button data-action="pause" aria-label="Pause game"><svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true"><path d="M3 2v16M15 2v16" stroke="currentColor" stroke-width="4"/></svg></button></div>
      <div class="m-hp"><span data-hp-fill></span><small data-hp></small></div>
      <div class="m-xp" role="progressbar" aria-label="Experience" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <div class="m-kills" data-kills></div><div class="m-banner" data-banner role="status"></div>
    </div>
    <section class="m-sheet" hidden aria-labelledby="m-title">
      <div class="m-heading"><img src="${new URL('./favicon.svg', import.meta.url).href}" width="34" height="34" alt=""><span class="m-eyebrow">AZEROTH SURVIVORS</span></div>
      <h1 id="m-title"></h1><p class="m-subtitle"></p>
      <div class="m-menu" hidden>
        <label>Class<select data-select="selectClass" aria-label="Class"></select></label>
        <label>Hero<select data-select="selectLook" aria-label="Hero appearance"></select></label>
        <label>Battleground<select data-select="selectMap" aria-label="Battleground"></select></label>
        <p class="m-instructions">Drag the thumbstick to move. Your spells cast automatically. Escape unlocks at level 5.</p>
        <button class="m-primary" data-action="start">Enter battleground</button>
      </div>
      <div class="m-offers" hidden></div>
      <div class="m-pause" hidden><button class="m-primary" data-action="resume">Return to battle</button><button data-action="menu">Choose another hero</button></div>
      <div class="m-results" hidden><p data-results></p><button class="m-primary" data-action="menu">Play again</button></div>
      <div class="m-settings"><button data-hand aria-label="Switch to left-handed controls">Left-handed</button><button data-help aria-expanded="false">How to play</button></div>
      <p class="m-help" hidden>Hold and drag the stick with your thumb. Release to stop. Tap Escape beside the stick to use your class movement spell in the last direction you moved. Pick an upgrade each time you level up. Add to Home Screen from Safari’s Share menu for a full-screen experience.</p>
    </section>
    <div class="m-controls" hidden>
      <div class="m-stick" role="group" aria-label="Drag to move"><span class="m-stick-ring"></span><span class="m-stick-knob"></span><small>MOVE</small></div>
      <button class="m-escape" data-action="mobility"><svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 19 5M6 5h13v13" fill="none" stroke="currentColor" stroke-width="2"/></svg><span data-mobility>Escape</span><small data-cooldown>Level 5</small></button>
    </div>
    <div class="m-loading" hidden role="status">Entering battleground…</div>`;
  document.body.append(root);
  const $ = selector => root.querySelector(selector);
  const show = (selector, on) => { $(selector).hidden = !on; };
  let state = null;
  let pointer = null;
  let origin = null;
  let phase = '';
  let catalogKey = '';
  let offersKey = '';
  let lastSequence = 0;
  let left = false;
  try { left = localStorage.getItem('survivors:left-handed') === '1'; } catch {}
  const setHand = () => {
    root.classList.toggle('m-left', left);
    $('[data-hand]').textContent = left ? 'Right-handed' : 'Left-handed';
    $('[data-hand]').setAttribute('aria-label', `Switch to ${left ? 'right' : 'left'}-handed controls`);
  };
  setHand();
  const stick = $('.m-stick');
  const knob = $('.m-stick-knob');
  const reset = () => {
    input.x = input.y = 0;
    const captured = pointer;
    pointer = null;
    if (captured !== null && stick.hasPointerCapture(captured)) stick.releasePointerCapture(captured);
    knob.style.transform = 'translate(-50%, -50%)';
    stick.classList.remove('m-held');
  };
  const command = (action, index = 0) => {
    // Only one outstanding command; controls become available on the next engine snapshot.
    if (input.sequence !== lastSequence) return;
    input.action = action;
    input.index = index;
    input.sequence += 1;
    if (action !== 'mobility') reset();
  };
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (button && !button.disabled) command(button.dataset.action, Number(button.dataset.index ?? 0));
  });
  root.addEventListener('change', event => {
    const select = event.target.closest('[data-select]');
    if (select) command(select.dataset.select, Number(select.value));
  });
  $('[data-hand]').addEventListener('click', () => {
    reset(); left = !left; setHand();
    try { localStorage.setItem('survivors:left-handed', left ? '1' : '0'); } catch {}
  });
  $('[data-help]').addEventListener('click', () => {
    $('.m-help').hidden = !$('.m-help').hidden;
    $('[data-help]').setAttribute('aria-expanded', String(!$('.m-help').hidden));
  });
  // Stop canvas/winit listeners from treating UI touches as world aiming or clicks.
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend']) {
    root.addEventListener(name, event => event.stopPropagation());
  }
  stick.addEventListener('pointerdown', event => {
    if (pointer !== null || state?.phase !== 'Playing' || state.loading) return;
    event.preventDefault();
    pointer = event.pointerId;
    const bounds = stick.getBoundingClientRect();
    origin = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    stick.setPointerCapture(pointer);
    stick.classList.add('m-held');
    move(event);
  });
  function move(event) {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
    const radius = stick.clientWidth * 0.34;
    const vector = stickVector(dx, dy, radius);
    input.x = vector.x; input.y = vector.y;
    const factor = Math.min(1, radius / (Math.hypot(dx, dy) || 1));
    knob.style.transform = `translate(calc(-50% + ${dx * factor}px), calc(-50% + ${dy * factor}px))`;
  }
  stick.addEventListener('pointermove', move);
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stick.addEventListener(event, e => { if (e.pointerId === pointer) reset(); });
  }
  // Persist the pause request across a completely suspended animation loop.
  const suspend = () => { reset(); input.hidden = true; input.pauseSequence += 1; };
  window.addEventListener('blur', suspend);
  window.addEventListener('pagehide', suspend);
  window.addEventListener('focus', () => { input.hidden = document.hidden; });
  window.addEventListener('pageshow', () => { input.hidden = document.hidden; reset(); });
  window.addEventListener('resize', reset);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else { reset(); input.hidden = false; }
  });
  const raceNames = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll' };
  const options = (selector, items, selected, label) => {
    const select = $(selector);
    select.replaceChildren(...items.map((item, index) => {
      const option = document.createElement('option');
      option.value = item.index ?? index; option.textContent = label(item); return option;
    }));
    select.value = selected ?? '';
  };
  function render() {
    state = window.__survivorsMobileState;
    if (!state) return;
    // The engine writes the sequence it consumed, allowing the next command.
    lastSequence = state.sequence;
    const playing = state.phase === 'Playing';
    if (state.phase !== phase) {
      reset(); phase = state.phase;
      const titles = { Menu: 'Choose your survivor', LevelUp: 'Choose your power', Paused: 'Take a breath', GameOver: state.won ? 'Victory earned' : 'One more run?' };
      $('#m-title').textContent = titles[phase] ?? '';
      $('.m-subtitle').textContent = { Menu: 'One hero. Endless enemies.', LevelUp: `Level ${state.level} · Choose one upgrade`, Paused: 'Your battle is paused.', GameOver: 'Every survivor has another story.' }[phase] ?? '';
      if (!playing) $('#m-title').focus({ preventScroll: true });
    }
    show('.m-sheet', !playing);
    show('.m-hud', playing);
    show('.m-controls', playing && !state.loading);
    show('.m-menu', phase === 'Menu'); show('.m-offers', phase === 'LevelUp');
    show('.m-pause', phase === 'Paused'); show('.m-results', phase === 'GameOver');
    show('.m-loading', state.loading && playing);
    const seconds = Math.floor(state.elapsed ?? 0);
    $('[data-time]').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('[data-level]').textContent = `Level ${state.level}`;
    $('[data-hp]').textContent = `${Math.ceil(Math.max(0, state.hp))} / ${Math.ceil(state.maxHp)} HP`;
    $('[data-hp-fill]').style.width = `${Math.max(0, Math.min(100, state.hp / state.maxHp * 100))}%`;
    const xp = Math.max(0, Math.min(100, state.xp / state.xpNeeded * 100));
    $('.m-xp span').style.width = `${xp}%`;
    $('.m-xp').setAttribute('aria-valuenow', String(Math.round(xp)));
    $('[data-kills]').textContent = `${state.kills} defeated`;
    $('[data-banner]').textContent = state.banner ?? '';
    $('[data-results]').textContent = `Level ${state.level} · ${Math.floor(seconds / 60)}m ${seconds % 60}s survived · ${state.kills} defeated`;
    const mobility = state.mobility ?? {};
    $('[data-mobility]').textContent = mobility.name || 'Escape';
    $('[data-cooldown]').textContent = mobility.learned ? (mobility.cd > 0 ? `${Math.ceil(mobility.cd)}s` : 'Ready') : 'Level 5';
    $('.m-escape').disabled = !mobility.learned || mobility.cd > 0;
    const key = JSON.stringify([state.classes, state.maps, state.looks, state.selectedClass, state.selectedLook, state.selectedMap]);
    if (key !== catalogKey) {
      catalogKey = key;
      options('[data-select="selectClass"]', state.classes ?? [], state.selectedClass, item => item.name);
      options('[data-select="selectLook"]', state.looks ?? [], state.selectedLook, item => `${raceNames[item.race] ?? 'Hero'} · ${item.sex === 0 ? 'Male' : 'Female'}`);
      options('[data-select="selectMap"]', state.maps ?? [], state.selectedMap, item => item.name);
    }
    // Starting selects the destination; terrain readiness gates play, not the menu.
    $('[data-action="start"]').disabled = state.selectedClass == null || state.selectedLook == null;
    const offerKey = JSON.stringify(state.offers);
    if (offerKey !== offersKey) {
      offersKey = offerKey;
      $('.m-offers').replaceChildren(...(state.offers ?? []).map((offer, index) => {
        const button = document.createElement('button');
        button.className = 'm-offer'; button.dataset.action = 'pick'; button.dataset.index = index;
        const title = document.createElement('strong'); title.textContent = offer.title;
        const description = document.createElement('span'); description.textContent = offer.description;
        const details = document.createElement('small');
        details.textContent = Array.isArray(offer.details) ? offer.details.join(' · ') : offer.details ?? '';
        button.append(title, description, details); return button;
      }));
    }
  }
  $('#m-title').tabIndex = -1;
  const timer = setInterval(render, 100);
  return { input, root, render, reset, dispose() { clearInterval(timer); reset(); input.active = false; root.remove(); } };
}
