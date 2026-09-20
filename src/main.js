import { createFluidSim } from './fluid/fluidCore.js';
import { createLoop, scaleByPixelRatio } from './app/loop.js';
import { attachPointerInput } from './app/pointerInput.js';
import { renderFrame } from './app/frame.js';
import { createSimGUI } from './ui/gui.js';
import { createTrackPicker } from './ui/trackPicker.js';
import { createDebugOverlay } from './ui/debugOverlay.js';
import { createTransport } from './ui/transport.js';
import { createExportPanel } from './ui/exportPanel.js';
import { captureScreenshot } from './export/screenshot.js';
import { makeStreams } from './util/rng.js';
import { decodeForAnalysis, ANALYSIS_SAMPLE_RATE } from './audio/decode.js';
import { analyzeTrack } from './audio/analyze.js';
import { createPlayer } from './audio/player.js';
import { createMapping } from './mapping/index.js';
import { PRESETS, DEFAULT_SIM, pickPreset } from './presets/index.js';

const canvas = document.querySelector('canvas');
const player = createPlayer();
const overlay = createDebugOverlay(document.body);

let streams = makeStreams(0x5eed);
let timeline = null;
let mapping = null;
let preset = null;
let trackName = '';
let presetChoice = 'auto';
let seed = 0x5eed;

const sim = createFluidSim(canvas, { rng: () => streams.rngSim(), initialSplats: 6, config: DEFAULT_SIM });
sim.setSize(scaleByPixelRatio(canvas.clientWidth), scaleByPixelRatio(canvas.clientHeight));

attachPointerInput(sim);
const gui = createSimGUI(sim, {
  onScreenshot: () => captureScreenshot(sim),
  getMapping: () => mapping
});

// `playing` gates the mapping: once a track ends it must stop driving, or the idle bed
// keeps circling forever. See the liveness note in mapping/index.js.
// `playing` lives inside `features` because that is what renderFrame forwards to the
// mapping. Putting it on the outer object meant it never arrived.
const frameCtx = { mapping: null, features: { live: null, playing: true }, interactive: true };
let lastTime = 0;

function buildMapping(at = 0) {
  if (!timeline) return;
  mapping = createMapping({ timeline, preset, rng: streams.rngMap });
  mapping.reset(at);
  frameCtx.mapping = mapping;
}

function applyPreset(next, { rebuild = true } = {}) {
  preset = next;
  sim.setConfig(preset.sim);
  if (rebuild) buildMapping(player.currentTime);
  gui.controllers.forEach((c) => c.updateDisplay());
}

const exportPanel = createExportPanel(document.body, {
  canvas,
  player,
  // Read live, so the panel always exports what is currently on screen.
  getState: () => ({ timeline, preset, seed, trackName })
});

const transport = createTransport(document.body, {
  player,
  getMapping: () => mapping,
  onOpen: () => picker.show(),
  onExport: () => exportPanel.show(),
  onPreset: (name) => {
    presetChoice = name;
    applyPreset(name === 'auto' ? pickPreset(timeline) : PRESETS[name]);
    transport.setTrack(trackName, mapping);
  },
  onPalette: (name) => mapping?.setPalette(name),
  onAtmosphere: (name) => mapping?.forceAtmosphere(name)
});

const picker = createTrackPicker(document.body, {
  async onLoad(fileOrUrl, name, setStatus) {
    const decoded = await decodeForAnalysis(fileOrUrl, (notice) => setStatus(notice));
    setStatus('Analysing…');

    const result = await analyzeTrack(
      { mono: decoded.mono, name, sampleRate: ANALYSIS_SAMPLE_RATE },
      (p) => setStatus(`Analysing… ${Math.round(p * 100)}%`)
    );

    timeline = result.timeline;
    trackName = name;
    // Seed from audio content, so the same track always renders the same way.
    seed = result.seed;
    streams = makeStreams(result.seed);

    applyPreset(presetChoice === 'auto' ? pickPreset(timeline) : PRESETS[presetChoice], { rebuild: false });
    buildMapping(0);
    sim.clear();

    player.load(decoded.buffer);
    await player.play();

    transport.setPreset(presetChoice);
    transport.setTrack(name, mapping);

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
  frameCtx.features.playing = player.playing;
  renderFrame(sim, frameCtx, t, dt);
  overlay.draw(timeline, t);
  transport.update();
});

sim.ready.then(() => loop.start());

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'KeyP') sim.setConfig({ PAUSED: !sim.config.PAUSED });
  if (e.code === 'KeyD') overlay.toggle();
  if (e.code === 'KeyO') picker.show();
  if (e.code === 'KeyC') sim.clear();
  if (e.code === 'KeyE') exportPanel.toggle();
  if (e.code === 'Escape') exportPanel.hide();
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
  window.synthTest = async (opts) => {
    const m = await import('./dev/synthtest.js');
    return m.synthTest(opts);
  };
  window.selfTest = async (opts) => {
    const m = await import('./dev/selftest.js');
    return m.selfTest(opts);
  };
  window.checkDeterminism = async (opts) => {
    const m = await import('./dev/determinism.js');
    const result = await m.checkDeterminism(opts);
    console.log(m.formatResult(result));
    return result;
  };
}
