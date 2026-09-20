/**
 * Proves a render is reproducible.
 *
 * Runs the same sequence twice from a fresh simulation and compares, at two levels:
 *
 *   splats — the inputs we fed the sim. Machine-independent. If these diverge, something
 *            in the seeding or the mapping is reading state it shouldn't.
 *   pixels — what actually came out. Only meaningful on one machine, since the sim runs
 *            on half-float textures and drivers differ, but it catches everything.
 *
 * A pixel mismatch with matching splats means the nondeterminism is below our layer
 * (driver, texture precision) rather than in our code — worth knowing, and the reason the
 * two are reported separately instead of as one pass/fail.
 */
import { createFluidSim } from '../fluid/fluidCore.js';
import { renderFrame } from '../app/frame.js';
import { hashPixels, createSplatRecorder } from '../util/frameHash.js';
import { makeStreams } from '../util/rng.js';

const TEST_WIDTH = 320; // readPixels is the slow part; small is fine for a hash
const TEST_HEIGHT = 180;
const DT = 1 / 60;

/**
 * @param script  called each frame as script(sim, frameIndex, rngMap) — stand-in for the
 *                mapping layer until it exists, and a way to test it once it does.
 */
async function runOnce({ seed, frames, script }) {
  const canvas = document.createElement('canvas');
  canvas.width = TEST_WIDTH;
  canvas.height = TEST_HEIGHT;

  const streams = makeStreams(seed);
  const recorder = createSplatRecorder();
  const sim = createFluidSim(canvas, {
    rng: streams.rngSim,
    initialSplats: 0,
    onSplat: recorder.onSplat
  });

  // Frame 0 must not run against the 1x1 placeholder dithering texture.
  await sim.ready;
  sim.setSize(TEST_WIDTH, TEST_HEIGHT);
  sim.clear();

  const ctx = { mapping: null, features: null, interactive: false };
  const frameHashes = [];
  let buffer = null;

  for (let f = 0; f < frames; f++) {
    if (script) script(sim, f, streams.rngMap);
    renderFrame(sim, ctx, f * DT, DT);
    const out = hashPixels(sim, buffer);
    buffer = out.buffer;
    frameHashes.push(out.hash);
  }

  sim.dispose();
  return { frameHashes, splatHash: recorder.hash, splatCount: recorder.count };
}

/** Default exercise: periodic seeded bursts, so the RNG stream actually matters. */
function defaultScript(sim, f, rngMap) {
  if (f % 20 !== 0) return;
  const n = 3 + Math.floor(rngMap() * 4);
  for (let i = 0; i < n; i++) {
    const x = rngMap();
    const y = rngMap();
    const dx = 1000 * (rngMap() - 0.5);
    const dy = 1000 * (rngMap() - 0.5);
    sim.splat(x, y, dx, dy, sim.generateColor());
  }
}

export async function checkDeterminism({ seed = 0x5eed, frames = 300, script = defaultScript } = {}) {
  const a = await runOnce({ seed, frames, script });
  const b = await runOnce({ seed, frames, script });

  let firstDivergence = -1;
  for (let i = 0; i < frames; i++) {
    if (a.frameHashes[i] !== b.frameHashes[i]) {
      firstDivergence = i;
      break;
    }
  }
  const identical = frames - (firstDivergence === -1 ? 0 : frames - firstDivergence);

  const result = {
    frames,
    seed,
    splats: {
      count: a.splatCount,
      match: a.splatHash === b.splatHash,
      hash: a.splatHash
    },
    pixels: {
      match: firstDivergence === -1,
      identicalFrames: identical,
      firstDivergence
    }
  };

  // A different seed must produce a different render, or the test proves nothing.
  const other = await runOnce({ seed: seed + 1, frames: Math.min(frames, 60), script });
  result.seedActuallyMatters = other.splatHash !== a.splatHash;

  return result;
}

export function formatResult(r) {
  const lines = [
    `seed 0x${r.seed.toString(16)}, ${r.frames} frames`,
    `splats: ${r.splats.count} calls, ${r.splats.match ? 'IDENTICAL' : 'DIVERGED'} (${r.splats.hash})`,
    `pixels: ${r.pixels.identicalFrames}/${r.frames} frames identical` +
      (r.pixels.match ? '' : ` — first divergence at frame ${r.pixels.firstDivergence}`),
    `seed changes output: ${r.seedActuallyMatters ? 'yes' : 'NO — seeding is not wired up'}`
  ];
  return lines.join('\n');
}
