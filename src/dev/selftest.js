/**
 * End-to-end self test. Run from the console: `await window.selfTest()`.
 *
 * Drives every track through decode, analysis and the full mapping at several frame
 * rates, asserting the things that actually break in practice: NaN leaking into the
 * simulation config, parameters escaping their clamps, onsets being missed or fired
 * twice, renders failing to reproduce, and frame rate changing the output.
 *
 * Deliberately headless — it builds its own small canvases rather than touching the live
 * one, so it can run while the app is playing.
 */
import { decodeForAnalysis, ANALYSIS_SAMPLE_RATE } from '../audio/decode.js';
import { analyzeTrack } from '../audio/analyze.js';
import { createFluidSim } from '../fluid/fluidCore.js';
import { createMapping } from '../mapping/index.js';
import { createSplatRecorder } from '../util/frameHash.js';
import { makeStreams } from '../util/rng.js';
import { PRESETS, pickPreset } from '../presets/index.js';
import { assignAtmospheres, ATMOSPHERE_NAMES, ATMOSPHERES } from '../mapping/atmospheres.js';
import { createFeel } from '../mapping/feel.js';

const TRACKS = [
  ['EDM', '/music/Elley Duhé & Whethan - MONEY ON THE DASH (Audio).mp3'],
  ['mixed', '/music/MVハート111ゆーりオリジナル.mp3'],
  ['lead', '/music/1 Lead Vocal.mp3']
];

const CLAMPS = createFeel({}).limits;

function makeSim(w, h, rng, onSplat) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return createFluidSim(canvas, { rng, initialSplats: 0, onSplat });
}

/** Run a mapping over a span and collect everything worth asserting on. */
async function drive(timeline, preset, { seed = 0x5eed, start = 0, seconds = 10, fps = 60, size = 192 } = {}) {
  const st = makeStreams(seed);
  const rec = createSplatRecorder();
  const sim = makeSim(size, Math.round(size * 0.5625), st.rngSim, rec.onSplat);
  await sim.ready;
  sim.setSize(size, Math.round(size * 0.5625));
  sim.clear();

  const m = createMapping({ timeline, preset, rng: st.rngMap });
  m.reset(start);

  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  const atmospheres = new Set();
  const postures = new Set();
  const outOfRange = [];
  let nonFinite = 0;
  let maxFrameMs = 0;
  let totalMs = 0;

  for (let f = 0; f < frames; f++) {
    const t0 = performance.now();
    m.applyFrame(sim, { live: null }, start + f * dt, dt);
    sim.step(dt);
    sim.render(null);
    const ms = performance.now() - t0;
    // Skip warm-up: the first frames include shader compilation and framebuffer
    // allocation, which would otherwise dominate the maximum and tell us nothing.
    if (f >= 10) {
      totalMs += ms;
      if (ms > maxFrameMs) maxFrameMs = ms;
    }

    atmospheres.add(m.arc.atmosphereName);
    postures.add(m.arc.posture);

    for (const key in CLAMPS) {
      const v = sim.config[key];
      if (!Number.isFinite(v)) nonFinite++;
      else if (v < CLAMPS[key][0] - 1e-6 || v > CLAMPS[key][1] + 1e-6) {
        if (outOfRange.length < 5) outOfRange.push(`${key}=${v.toFixed(3)}`);
      }
    }
    for (const k of ['coil', 'burst', 'intensity']) {
      if (!Number.isFinite(m.arc[k])) nonFinite++;
    }
  }

  const out = {
    splats: rec.count,
    hash: rec.hash,
    atmospheres: [...atmospheres],
    postures: [...postures],
    outOfRange,
    nonFinite,
    avgFrameMs: +(totalMs / Math.max(1, frames - 10)).toFixed(2),
    maxFrameMs: +maxFrameMs.toFixed(2)
  };
  sim.dispose();
  return out;
}

export async function selfTest({ verbose = true, only = null, fullSeconds = 120 } = {}) {
  const results = [];
  const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    if (verbose) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const tracks = only ? TRACKS.filter(([l]) => l === only) : TRACKS;
  for (const [label, url] of tracks) {
    let timeline;
    try {
      const decoded = await decodeForAnalysis(url);
      const res = await analyzeTrack({ mono: decoded.mono, name: label, sampleRate: ANALYSIS_SAMPLE_RATE });
      timeline = res.timeline;
    } catch (err) {
      check(`${label}: analyse`, false, err.message);
      continue;
    }

    const tl = timeline;
    check(
      `${label}: analysis sane`,
      tl.numFrames > 0 && tl.duration > 10 && tl.onsetTimes.length > 20,
      `${tl.duration.toFixed(0)}s, ${tl.onsetTimes.length} onsets, ${tl.sectionCount} sections, profile ${tl.profile}`
    );

    // Onsets must be sorted and inside the track.
    let sorted = true;
    for (let i = 1; i < tl.onsetTimes.length; i++) if (tl.onsetTimes[i] < tl.onsetTimes[i - 1]) sorted = false;
    check(
      `${label}: onsets ordered and in range`,
      sorted && tl.onsetTimes[0] >= 0 && tl.onsetTimes[tl.onsetTimes.length - 1] <= tl.duration + 0.1
    );

    // No NaN anywhere in the timeline arrays.
    let badField = null;
    for (const [k, v] of Object.entries(tl)) {
      if (!ArrayBuffer.isView(v) || v instanceof Int32Array || v instanceof Uint8Array) continue;
      for (let i = 0; i < v.length; i += 37) {
        if (!Number.isFinite(v[i])) {
          badField = k;
          break;
        }
      }
      if (badField) break;
    }
    check(`${label}: timeline has no NaN`, !badField, badField ? `bad field: ${badField}` : '');

    // Sections should tile the track with no gaps.
    let tiled = tl.sectionIndex[0] === 0;
    for (let f = 1; f < tl.numFrames; f++) {
      const d = tl.sectionIndex[f] - tl.sectionIndex[f - 1];
      if (d !== 0 && d !== 1) tiled = false;
    }
    check(`${label}: sections tile the track`, tiled, `${tl.sectionCount} sections`);

    // Atmospheres: variety, and never the same twice running.
    const idx = assignAtmospheres(tl.sectionStats, tl.sectionCount);
    let repeats = 0;
    for (let i = 1; i < idx.length; i++) if (idx[i] === idx[i - 1]) repeats++;
    const distinct = new Set(Array.from(idx)).size;
    check(
      `${label}: atmospheres varied`,
      distinct >= 3 && repeats === 0,
      `${distinct} distinct, ${repeats} consecutive repeats: ${Array.from(idx, (i) => ATMOSPHERE_NAMES[i]).join(' > ')}`
    );

    const preset = pickPreset(tl);

    // Full-length pass: the real test, since it crosses every boundary in the track.
    const coveredSeconds = Math.min(tl.duration, fullSeconds);
    const full = await drive(tl, preset, { seconds: coveredSeconds, fps: 60, size: 128 });

    // How many sections the pass actually crossed — asserting "at least 3 atmospheres"
    // regardless would fail purely because the caller asked for a short pass.
    let sectionsCovered = 1;
    for (let i = 1; i < tl.sectionBounds.length; i++) {
      if (tl.sectionBounds[i] < coveredSeconds) sectionsCovered++;
    }
    const expectAtmospheres = Math.min(3, sectionsCovered);
    check(`${label}: full pass, no NaN in config`, full.nonFinite === 0, `${full.nonFinite} non-finite reads`);
    check(
      `${label}: parameters stay clamped`,
      full.outOfRange.length === 0,
      full.outOfRange.join(', ')
    );
    check(
      `${label}: visits multiple atmospheres`,
      full.atmospheres.length >= expectAtmospheres,
      `${full.atmospheres.join(', ')} over ${sectionsCovered} section(s) in ${coveredSeconds.toFixed(0)}s`
    );
    check(
      `${label}: uses more than one posture`,
      full.postures.length >= 2,
      full.postures.join(', ')
    );

    // Determinism, over a span containing a section boundary.
    const mid = Math.min(tl.duration - 12, Math.max(0, tl.sectionBounds[1] ?? 20) - 4);
    const a = await drive(tl, preset, { start: mid, seconds: 12 });
    const b = await drive(tl, preset, { start: mid, seconds: 12 });
    const c = await drive(tl, preset, { start: mid, seconds: 12, seed: 0x5eed + 1 });
    check(`${label}: reproducible`, a.hash === b.hash, `${a.splats} splats`);
    check(`${label}: seed changes output`, a.hash !== c.hash);

    // Frame-rate independence: same wall time, same splat budget.
    const at30 = await drive(tl, preset, { start: mid, seconds: 12, fps: 30 });
    const ratio = at30.splats / Math.max(1, a.splats);
    check(
      `${label}: 30fps matches 60fps`,
      ratio > 0.9 && ratio < 1.1,
      `ratio ${ratio.toFixed(3)} (${at30.splats} vs ${a.splats})`
    );

    // Every onset fires exactly once, whatever the frame rate.
    const counted = (fps) => {
      tl.resetCursor(mid);
      const dt = 1 / fps;
      const seen = [];
      let prev = mid;
      for (let f = 1; f <= Math.round(12 * fps); f++) {
        const t = mid + f * dt;
        for (const o of tl.onsetsBetween(prev, t)) seen.push(o.index);
        prev = t;
      }
      return seen;
    };
    const s60 = counted(60);
    const s30 = counted(30);
    const s144 = counted(144);
    const uniq = (a) => new Set(a).size === a.length;
    check(
      `${label}: onsets fire once at any frame rate`,
      uniq(s60) && uniq(s30) && uniq(s144) && s60.length === s30.length && s60.length === s144.length,
      `${s60.length} at 60fps, ${s30.length} at 30, ${s144.length} at 144`
    );

    check(
      `${label}: frame cost`,
      full.avgFrameMs < 8,
      `avg ${full.avgFrameMs}ms, max ${full.maxFrameMs}ms at 128px`
    );
  }

  // The guard that stops the mapping wiping the dye 60 times a second.
  const st = makeStreams(1);
  const sim = makeSim(64, 36, st.rngSim);
  await sim.ready;
  let threw = false;
  try {
    sim.setConfigFast({ DYE_RESOLUTION: 256 });
  } catch {
    threw = true;
  }
  check('setConfigFast rejects framebuffer keys', threw);
  sim.setConfigFast({ CURL: 42 });
  check('setConfigFast writes hot-path keys', sim.config.CURL === 42);
  sim.dispose();

  // Palettes must stay in gamut whatever they are handed.
  const { createBlendedPalette } = await import('../color/palettes.js');
  const bp = createBlendedPalette('ember', 'ice');
  let gamutOk = true;
  const col = {};
  for (let i = 0; i <= 20; i++) {
    bp.setMix(i / 20);
    for (let p = 0; p <= 10; p++) {
      bp.colorAt(p / 10, 0.5, col, 0.37);
      for (const ch of ['r', 'g', 'b']) {
        if (!Number.isFinite(col[ch]) || col[ch] < 0 || col[ch] > 1) gamutOk = false;
      }
    }
  }
  check('blended palette stays in gamut', gamutOk);

  const failed = results.filter((r) => !r.pass);
  const summary = `${results.length - failed.length}/${results.length} passed`;
  if (verbose) console.log(`\n${failed.length ? 'FAILURES: ' + failed.map((f) => f.name).join('; ') : 'all passed'} (${summary})`);
  return { summary, failed: failed.map((f) => ({ name: f.name, detail: f.detail })), results };
}
