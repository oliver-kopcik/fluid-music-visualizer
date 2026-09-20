/**
 * Transport bar: play, scrub, and the controls worth reaching for while listening.
 *
 * The seek bar is segmented by section and coloured by the atmosphere each one was
 * assigned. That turns the analysis into something you can see and use — the structure of
 * the track is visible at a glance, and clicking a segment jumps straight to it, which is
 * the only practical way to audition one atmosphere against another.
 *
 * Auto-hides while the mouse is still, because this is a visualizer and the picture
 * should not be permanently occluded by a toolbar.
 */
import { PRESETS } from '../presets/index.js';
import { PALETTE_NAMES } from '../color/palettes.js';
import { ATMOSPHERE_NAMES } from '../mapping/atmospheres.js';

const IDLE_MS = 2600;

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export function createTransport(container, { player, getMapping, onPreset, onPalette, onAtmosphere, onOpen }) {
  const root = document.createElement('div');
  root.className = 'transport';
  root.innerHTML = `
    <div class="tp-scrub" role="slider" tabindex="0" aria-label="Seek">
      <div class="tp-sections"></div>
      <div class="tp-played"></div>
      <div class="tp-head"></div>
    </div>
    <div class="tp-row">
      <button class="tp-btn tp-play" title="Play / pause (space)">▶</button>
      <span class="tp-time">0:00 / 0:00</span>
      <span class="tp-title">no track</span>
      <span class="tp-spacer"></span>
      <span class="tp-badge" title="Current atmosphere">—</span>
      <label class="tp-field">preset
        <select class="tp-preset"></select>
      </label>
      <label class="tp-field">palette
        <select class="tp-palette"></select>
      </label>
      <label class="tp-field">atmos
        <select class="tp-atmos"></select>
      </label>
      <label class="tp-field tp-vol">vol
        <input class="tp-volume" type="range" min="0" max="1" step="0.01" value="1" />
      </label>
      <button class="tp-btn tp-open" title="Open another track (O)">open</button>
    </div>`;
  container.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const scrub = $('.tp-scrub');
  const sectionsEl = $('.tp-sections');
  const playedEl = $('.tp-played');
  const headEl = $('.tp-head');
  const playBtn = $('.tp-play');
  const timeEl = $('.tp-time');
  const titleEl = $('.tp-title');
  const badgeEl = $('.tp-badge');
  const presetSel = $('.tp-preset');
  const paletteSel = $('.tp-palette');
  const atmosSel = $('.tp-atmos');
  const volume = $('.tp-volume');

  const opt = (el, values, labels) => {
    el.innerHTML = '';
    values.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labels ? labels[i] : v;
      el.appendChild(o);
    });
  };

  opt(presetSel, ['auto', ...Object.keys(PRESETS)], ['auto', ...Object.values(PRESETS).map((p) => p.label)]);
  opt(paletteSel, ['auto', ...PALETTE_NAMES]);
  opt(atmosSel, ['auto', ...ATMOSPHERE_NAMES]);

  playBtn.onclick = () => player.toggle();
  $('.tp-open').onclick = () => onOpen?.();
  volume.oninput = () => player.setVolume(Number(volume.value));
  presetSel.onchange = () => onPreset?.(presetSel.value);
  paletteSel.onchange = () => onPalette?.(paletteSel.value);
  atmosSel.onchange = () => onAtmosphere?.(atmosSel.value === 'auto' ? null : atmosSel.value);

  // --- scrubbing -------------------------------------------------------------------
  let scrubbing = false;
  const seekFromEvent = (e) => {
    const r = scrub.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    player.seek(frac * player.duration);
  };
  scrub.addEventListener('pointerdown', (e) => {
    if (!player.duration) return;
    scrubbing = true;
    scrub.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  scrub.addEventListener('pointermove', (e) => scrubbing && seekFromEvent(e));
  scrub.addEventListener('pointerup', (e) => {
    scrubbing = false;
    scrub.releasePointerCapture(e.pointerId);
  });
  scrub.addEventListener('keydown', (e) => {
    if (e.code === 'ArrowLeft') player.seek(player.currentTime - 5);
    if (e.code === 'ArrowRight') player.seek(player.currentTime + 5);
  });

  // --- auto-hide -------------------------------------------------------------------
  let idleTimer = null;
  const wake = () => {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Never hide while someone is actually using it.
      if (!scrubbing && !root.contains(document.activeElement)) root.classList.add('idle');
    }, IDLE_MS);
  };
  window.addEventListener('pointermove', wake);
  window.addEventListener('keydown', wake);
  root.addEventListener('pointerenter', wake);
  wake();

  // --- section bar -----------------------------------------------------------------
  let builtFor = null;
  function buildSections(mapping) {
    const key = mapping?.timeline?.name + ':' + (mapping?.timeline?.sectionCount ?? 0);
    if (!mapping || key === builtFor) return;
    builtFor = key;
    sectionsEl.innerHTML = '';
    const dur = mapping.timeline.duration || 1;
    for (const sec of mapping.sections) {
      const el = document.createElement('div');
      el.className = 'tp-sec';
      el.style.left = `${(sec.start / dur) * 100}%`;
      el.style.width = `${((sec.end - sec.start) / dur) * 100}%`;
      el.style.background = sec.swatch;
      el.title = `${sec.atmosphere} · ${fmt(sec.start)}–${fmt(sec.end)}`;
      sectionsEl.appendChild(el);
    }
  }

  function syncSelects(mapping) {
    if (!mapping) return;
    if (paletteSel.value !== (mapping.paletteOverride ?? 'auto')) {
      paletteSel.value = mapping.paletteOverride ?? 'auto';
    }
  }

  /** Called every frame. Kept to DOM writes that actually changed. */
  let lastText = '';
  let lastBadge = '';
  function update() {
    const mapping = getMapping?.();
    buildSections(mapping);

    const dur = player.duration || 0;
    const t = player.currentTime;
    const frac = dur ? t / dur : 0;
    // Width of the *remaining* part, since .tp-played dims the future.
    playedEl.style.width = `${(1 - frac) * 100}%`;
    headEl.style.left = `${frac * 100}%`;

    const text = `${fmt(t)} / ${fmt(dur)}`;
    if (text !== lastText) {
      timeEl.textContent = text;
      lastText = text;
    }

    playBtn.textContent = player.playing ? '❚❚' : '▶';

    const badge = mapping ? `${mapping.atmosphereName} · ${mapping.arc.posture}` : '—';
    if (badge !== lastBadge) {
      badgeEl.textContent = badge;
      lastBadge = badge;
    }
  }

  return {
    update,
    setTrack(name, mapping) {
      titleEl.textContent = name;
      titleEl.title = name;
      builtFor = null;
      buildSections(mapping);
      syncSelects(mapping);
      wake();
    },
    setPreset(name) {
      presetSel.value = name;
    },
    wake
  };
}
