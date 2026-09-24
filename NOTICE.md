# Notice

This project is built on top of
**[WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)** by
**Pavel Dobryakov**, used under the MIT License. See [`LICENSE`](./LICENSE).

The fluid dynamics — advection, divergence, pressure solve, vorticity confinement — and
every line of GLSL in this repository are his work. Nothing here reimplements any of it.

## What is vendored

The pristine upstream sources are kept unmodified in [`vendor/`](./vendor/), so the
structural diff in `src/fluid/` stays reviewable against them:

```
vendor/script.js        upstream fluid simulation (1645 lines)
vendor/index.html       upstream page
vendor/LDR_LLL1_0.png   dithering texture
vendor/LICENSE          upstream MIT license
```

## What is derived

`src/fluid/fluidCore.js` and `src/fluid/shaders.js` are **generated** from
`vendor/script.js` by the scripts in [`scripts/`](./scripts/), not hand-written and not
hand-edited. Re-run them with:

```bash
node scripts/extract-shaders.mjs
node scripts/build-core.mjs
npm run verify:core
```

The transform is structural only: an ES module wrapper, an injected RNG in place of
`Math.random`, explicit sizing in place of CSS-derived sizing, a caller-supplied `dt` in
place of the wall clock, and the removal of DOM, GUI and `requestAnimationFrame` coupling.
`npm run verify:core` enforces exactly that, and caps how many lines may be added.

There is **one deliberate change to upstream's GLSL**: the display shader's ordered
dithering is applied to the final image rather than only to the bloom term, because with
bloom disabled nothing was dithered at all and smooth gradients banded. It lives in a
documented `PATCHES` list in `scripts/extract-shaders.mjs` rather than as an edit to the
generated file, with the matching uniform binding in `scripts/build-core.mjs`.

## What is not derived

Everything outside `vendor/` and `src/fluid/` — the audio analysis (`src/audio/`), the
mapping from sound to motion (`src/mapping/`), the export pipeline (`src/export/`), the
application and interface (`src/app/`, `src/ui/`) and the test suites (`src/dev/`) — is
original work, MIT licensed.

## Third-party dependencies

| | |
|---|---|
| [fft.js](https://github.com/indutny/fft.js) | MIT |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | MIT |
| [webm-muxer](https://github.com/Vanilagy/webm-muxer) | MIT |
| [lil-gui](https://github.com/georgealways/lil-gui) | MIT |
| [Vite](https://vitejs.dev) | MIT |

No audio is distributed with this repository. `music/` and `exports/` are gitignored.
