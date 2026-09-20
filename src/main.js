import { createFluidSim } from './fluid/fluidCore.js';
import { createLoop, scaleByPixelRatio } from './app/loop.js';
import { attachPointerInput } from './app/pointerInput.js';
import { renderFrame } from './app/frame.js';
import { createSimGUI } from './ui/gui.js';
import { createTrackPicker } from './ui/trackPicker.js';
import { createDebugOverlay } from './ui/debugOverlay.js';
import { captureScreenshot } from './export/screenshot.js';
import { makeStreams } from './util/rng.js';
import { decodeForAnalysis, ANALYSIS_SAMPLE_RATE } from './audio/decode.js';
import { analyzeTrack } from './audio/analyze.js';
import { createPlayer } from './audio/player.js';
import { createMapping } from './mapping/index.js';
import { PRESETS, pickPreset } from './presets/index.js';

const canvas = document.querySelector('canvas');
const player = createPlayer();
const overlay = createDebugOverlay(document.body);

let streams = makeStreams(0x5eed);
let timeline = null;
let mapping = null;
let preset = null;

const sim = createFluidSim(canvas, { rng: () => streams.rngSim(), initialSplats: 6 });
sim.setSize(scaleByPixelRatio(canvas.clientWidth), scaleByPixelRatio(canvas.clientHeight));

attachPointerInput(sim);
const gui = createSimGUI(sim, {
  onScreenshot: () => captureScreenshot(sim),
  getMapping: () => mapping
});

const frameCtx = { mapping: null, features: { live: null }, interactive: true };
let lastTime = 0;

function applyPreset(next) {
  preset = next;
  sim.setConfig(preset.sim);
  if (timeline) {
    mapping = createMapping({ timeline, preset, rng: streams.rngMap });
    mapping.reset(player.currentTime);
    frameCtx.mapping = mapping;
  }
  gui.controllers.forEach((c) => c.updateDisplay());
}

const picker = createTrackPicker(document.body, {
  async onLoad(fileOrUrl, name, setStatus) {
    const decoded = await decodeForAnalysis(fileOrUrl);
    setStatus('Analysing…');

    const result = await analyzeTrack(
      { mono: decoded.mono, name, sampleRate: ANALYSIS_SAMPLE_RATE },
      (p) => setStatus(`Analysing… ${Math.round(p * 100)}%`)
    );

    timeline = result.timeline;
    // Seed from audio content, so the same track always renders the same way.
    streams = makeStreams(result.seed);

    applyPreset(pickPreset(timeline));
    sim.clear();

    player.load(decoded.buffer);
    await player.play();

    console.log(
      `${name}: ${timeline.duration.toFixed(1)}s · ${timeline.onsetTimes.length} onsets · ` +
        `${timeline.tempoBPM.toFixed(1)} BPM (coh ${timeline.kickCoherence.toFixed(2)}, ` +
        `grid ${timeline.gridUsable ? 'usable' : 'rejected'}) · profile ${timeline.profile} · ` +
        `preset ${preset.name}${result.cached ? ' · cached' : ''}`
    );
  }
});

const loop = createLoop(sim, (dt) => {
  const t = timeline ? player.currentTime : lastTime + dt;
  lastTime = t;
  renderFrame(sim, frameCtx, t, dt);
  overlay.draw(timeline, t);
});

sim.ready.then(() => loop.start());

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyP') sim.setConfig({ PAUSED: !sim.config.PAUSED });
  if (e.code === 'KeyD') overlay.toggle();
  if (e.code === 'KeyO') picker.show();
  if (e.code === 'KeyC') sim.clear();
  if (e.key === ' ') {
    e.preventDefault();
    if (timeline) player.toggle();
    else sim.pushRandomSplats(12);
  }
  if (e.code === 'ArrowRight') seekBy(5);
  if (e.code === 'ArrowLeft') seekBy(-5);
});

function seekBy(delta) {
  if (!timeline) return;
  player.seek(player.currentTime + delta);
  mapping?.reset(player.currentTime);
}

// defineProperty, not Object.assign — assign would invoke the getter once and copy null.
Object.assign(window, { sim, player, PRESETS, applyPreset });
Object.defineProperty(window, 'timeline', { get: () => timeline });
Object.defineProperty(window, 'mapping', { get: () => mapping });

if (import.meta.env.DEV) {
  window.checkDeterminism = async (opts) => {
    const m = await import('./dev/determinism.js');
    const result = await m.checkDeterminism(opts);
    console.log(m.formatResult(result));
    return result;
  };
}
