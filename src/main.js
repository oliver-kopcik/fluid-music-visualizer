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

const canvas = document.querySelector('canvas');
const player = createPlayer();
const overlay = createDebugOverlay(document.body);

let streams = makeStreams(0x5eed);
let timeline = null;

const sim = createFluidSim(canvas, { rng: () => streams.rngSim(), initialSplats: 6 });
sim.setSize(scaleByPixelRatio(canvas.clientWidth), scaleByPixelRatio(canvas.clientHeight));

attachPointerInput(sim);
createSimGUI(sim, { onScreenshot: () => captureScreenshot(sim) });

const picker = createTrackPicker(document.body, {
  async onLoad(fileOrUrl, name, setStatus) {
    const decoded = await decodeForAnalysis(fileOrUrl);
    setStatus('Analysing…');

    const result = await analyzeTrack(
      { mono: decoded.mono, name, sampleRate: ANALYSIS_SAMPLE_RATE },
      (p) => setStatus(`Analysing… ${Math.round(p * 100)}%`)
    );

    timeline = result.timeline;
    // Seed from the audio content, so the same track always renders the same way.
    streams = makeStreams(result.seed);
    timeline.resetCursor(0);

    player.load(decoded.buffer);
    await player.play();

    console.log(
      `${name}: ${timeline.duration.toFixed(1)}s, ${timeline.onsetTimes.length} onsets, ` +
        `${timeline.tempoBPM.toFixed(1)} BPM (conf ${timeline.tempoConfidence.toFixed(2)}, ` +
        `${timeline.gridUsable ? 'usable' : 'rejected'}), profile ${timeline.profile}` +
        `${result.cached ? ' [cached]' : ''}`
    );
  }
});

// Mapping arrives in M4; for now the timeline only drives the debug overlay.
const frameCtx = { mapping: null, features: null, interactive: true };
let lastTime = 0;

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
  if (e.key === ' ') {
    e.preventDefault();
    if (timeline) player.toggle();
    else sim.pushRandomSplats(12);
  }
  if (e.code === 'ArrowRight') player.seek(player.currentTime + 5);
  if (e.code === 'ArrowLeft') player.seek(player.currentTime - 5);
});

// defineProperty, not Object.assign — assign would invoke the getter once and copy the
// value, which is null at this point.
Object.assign(window, { sim, player });
Object.defineProperty(window, 'timeline', { get: () => timeline });

if (import.meta.env.DEV) {
  window.checkDeterminism = async (opts) => {
    const m = await import('./dev/determinism.js');
    const result = await m.checkDeterminism(opts);
    console.log(m.formatResult(result));
    return result;
  };
}
