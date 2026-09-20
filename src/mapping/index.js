/**
 * Orchestrates the three layers. This is the object renderFrame() calls.
 *
 * Order matters: FEEL first so the splat radius and dissipation this frame's splats land
 * into are already correct, then HITS (which may bump the radius further), then FLOW.
 */
import { createFeatureReader } from './features.js';
import { createFlow } from './flow.js';
import { createHits } from './hits.js';
import { createFeel } from './feel.js';
import { createPalette } from '../color/palettes.js';

export function createMapping({ timeline, preset, rng }) {
  const reader = createFeatureReader();
  const flow = createFlow(preset.flow ?? {}, rng);
  const hits = createHits(preset.hits ?? {}, rng);
  const feel = createFeel(preset.feel ?? {});
  let palette = createPalette(preset.color?.palette ?? 'spectral', rng);

  let tPrev = 0;
  let lastTransients = { radiusBoost: 0, bloomFlash: 0 };

  // Only speed the emitters with tempo when the grid is trustworthy.
  const tempoScale =
    timeline.gridUsable && timeline.tempoBPM
      ? 1 + 0.5 * (timeline.tempoBPM / 120 - 1)
      : 1;

  return {
    timeline,
    preset,

    get paletteName() {
      return palette.name;
    },
    setPalette(name) {
      palette = createPalette(name, rng);
    },

    /** Call on seek, on load, and before frame 0 of a render. */
    reset(t = 0) {
      reader.reset();
      flow.reset();
      hits.reset();
      feel.reset();
      timeline.resetCursor(t);
      tPrev = t;
      lastTransients = { radiusBoost: 0, bloomFlash: 0 };
    },

    applyFrame(sim, ctxFeatures, t, dt) {
      // A seek backwards, or the first frame — don't replay the whole gap as onsets.
      if (t < tPrev || t - tPrev > 0.5) {
        timeline.resetCursor(t);
        tPrev = t;
      }

      const f = reader.read(timeline, t, dt, tPrev, ctxFeatures?.live ?? null);
      tPrev = t;

      feel.apply(sim, f, dt, lastTransients);
      lastTransients = hits.apply(sim, f, dt, palette, timeline);
      flow.apply(sim, f, dt, palette, tempoScale);

      return f;
    },

    get features() {
      return reader.features;
    }
  };
}
