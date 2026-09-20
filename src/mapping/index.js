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

  /**
   * Seconds of lookahead applied when sampling the timeline. Positive makes the visuals
   * lead the audio.
   *
   * Smoothing cannot be free — even a 25ms attack lags by 25ms — and the fluid itself
   * takes a few frames to show a splat as visible motion. Because the whole track is
   * analysed up front we can simply read slightly ahead to cancel that, which a live-only
   * analyser could never do. Audio output latency also varies by machine, so this stays
   * adjustable rather than baked in.
   */
  let syncOffset = preset.syncOffset ?? 0.045;

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
      const tRead = Math.max(0, t + syncOffset);
      timeline.resetCursor(tRead);
      tPrev = tRead;
      lastTransients = { radiusBoost: 0, bloomFlash: 0 };
    },

    get syncOffset() {
      return syncOffset;
    },
    set syncOffset(v) {
      syncOffset = v;
      timeline.resetCursor(Math.max(0, tPrev + v));
    },

    applyFrame(sim, ctxFeatures, t, dt) {
      // Everything reads the timeline at the shifted time, including the onset cursor, so
      // hits and continuous motion stay aligned with each other.
      const tRead = Math.max(0, t + syncOffset);

      // A seek backwards, or the first frame — don't replay the whole gap as onsets.
      if (tRead < tPrev || tRead - tPrev > 0.5) {
        timeline.resetCursor(tRead);
        tPrev = tRead;
      }

      const f = reader.read(timeline, tRead, dt, tPrev, ctxFeatures?.live ?? null);
      tPrev = tRead;

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
