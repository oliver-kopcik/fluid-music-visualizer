import { createFluidSim } from './fluid/fluidCore.js';
import { createLoop, scaleByPixelRatio } from './app/loop.js';
import { attachPointerInput } from './app/pointerInput.js';
import { createSimGUI } from './ui/gui.js';
import { captureScreenshot } from './export/screenshot.js';
import { makeStreams, hashString } from './util/rng.js';

const canvas = document.querySelector('canvas');

// Fixed seed for now; once tracks can be loaded this is derived from the audio content so
// the same track always renders the same way.
const streams = makeStreams(hashString('fluid-music-visualizer'));

const sim = createFluidSim(canvas, {
  rng: streams.rngSim,
  initialSplats: 8
});

sim.setSize(scaleByPixelRatio(canvas.clientWidth), scaleByPixelRatio(canvas.clientHeight));

attachPointerInput(sim);
createSimGUI(sim, { onScreenshot: () => captureScreenshot(sim) });

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') sim.setConfig({ PAUSED: !sim.config.PAUSED });
  if (e.key === ' ') {
    e.preventDefault();
    sim.pushRandomSplats(12);
  }
});

const loop = createLoop(sim, (dt) => sim.frame(dt));

// The sunrays dithering texture loads async. Starting before it lands would mean the first
// frames use the 1x1 placeholder — harmless live, but it would make two exports differ.
sim.ready.then(() => loop.start());

// Handy while developing.
window.sim = sim;
