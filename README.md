# Fluid Music Visualizer

A music visualizer built on [Pavel Dobryakov's WebGL fluid simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation).
Audio drives the fluid in three layers — continuous flow, percussive hits, and parameter
modulation — and the result can be exported to video frame-accurately.

```bash
npm install
npm run dev          # http://localhost:5173
```

## Status

| Milestone | |
|---|---|
| M0 · Vite scaffold, upstream vendored | done |
| M1 · Modularized fluid core, lil-gui | done |
| M2 · Seeded RNG + determinism harness | done |
| M3 · Audio analysis worker + timeline | done |
| M4 · Playback + FLOW/HITS/FEEL mapping | done |
| M4b · Arc, atmospheres, test suites | done |
| M5 · Quick WebM export | |
| M6 · Deterministic MP4 export | |
| M7 · UI polish | |

## Tests

Both run in the browser console against the dev server:

```js
await window.synthTest()   // 30 assertions vs synthesised audio with known ground truth
await window.selfTest()    // end-to-end over the tracks in music/
await window.checkDeterminism()
```

`synthTest` is the stronger of the two. Real tracks can only be judged; the synthetic
signals have exact answers — kick k lands at exactly k·60/bpm, the sweep's centroid is a
known function of time, the arrangement changes section at 8, 16, 32 and 40 seconds. It
found four real bugs, including onsets reported 33ms early and every snare being drawn as
a kick. It also validates its own fixtures first, having been misled by a "hi-hat"
filtered at 306Hz.

## Audio

Drag a file onto the window, or drop audio into `music/` and restart the dev server for a
quick-pick menu. **`music/` is gitignored** — no audio is ever committed.

## Layout

```
vendor/            upstream sources, unmodified, for diffing against
src/fluid/         the simulation: fluidCore.js (derived) + shaders.js (extracted GLSL)
src/audio/         decode → FFT → onsets/tempo → timeline
src/mapping/       how audio features become splats and config changes
src/export/        MediaRecorder (quick) and WebCodecs (deterministic) paths
src/app/           render loops and input; frame.js is shared by live and export
```

### The fluid core is a derived file

`src/fluid/fluidCore.js` and `src/fluid/shaders.js` are generated from `vendor/script.js`:

```bash
node scripts/extract-shaders.mjs   # GLSL → shaders.js
node scripts/build-core.mjs        # the structural transform → fluidCore.js
npm run verify:core                # assert it is still only a structural transform
```

The transform is a list of line-range edits in `scripts/build-core.mjs`, each with a reason.
It makes the sim take its canvas, RNG and `dt` from the caller and own no DOM events, GUI or
`requestAnimationFrame` loop — nothing else. `npm run verify:core` enforces that: no wall-clock
reads, no unseeded `Math.random`, no listeners, and a cap on added lines.

**New visual behaviour goes in `src/mapping/`, never in `fluidCore.js`.** Keeping the core a
mechanical transform is what lets it be re-derived if upstream ever changes.

## Determinism

Renders are reproducible on a given machine: seeded RNG (`src/util/rng.js`), fixed `dt` in the
export loop, no pointer input during export, and an awaited dithering-texture load. The sim and
mapping layers draw from separate RNG streams so a change on one side can't shift the other.

Not bit-exact across GPUs — the sim runs on half-float textures.

## Credit

Simulation and GLSL © Pavel Dobryakov, MIT. See [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md).
