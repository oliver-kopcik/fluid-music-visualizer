/**
 * Orchestrates the layers. This is the object renderFrame() calls.
 *
 * ARC runs first and decides the posture — is the track coiling toward something,
 * bursting out of it, or resting — and how much output this moment deserves. Everything
 * downstream reads that, which is what stops a drop from being merely a louder verse.
 *
 * Then FEEL (so the splat radius and dissipation this frame's splats land into are right),
 * then HITS (which shove the emitters and may bump the radius further), then FLOW.
 */
import { createFeatureReader } from './features.js';
import { createEmitterSystem } from './emitters.js';
import { createArc } from './arc.js';
import { createFlow } from './flow.js';
import { createHits } from './hits.js';
import { createFeel } from './feel.js';
import { createPalette } from '../color/palettes.js';

export function createMapping({ timeline, preset, rng }) {
  const reader = createFeatureReader();
  const system = createEmitterSystem(preset.flow?.emitters ?? 6, rng);
  const arc = createArc();
  const flow = createFlow(preset.flow ?? {}, rng, system);
  const hits = createHits(preset.hits ?? {}, rng, system);
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

  /** Structural curves for the current instant, reused each frame. */
  const arcInput = {
    kind: 'mid',
    tension: 0,
    imminence: 0,
    release: 0,
    energy: 0,
    sectionIndex: 0
  };

  function readArc(t) {
    const frame = Math.min(timeline.numFrames - 1, Math.max(0, Math.round(t * timeline.frameRate)));
    arcInput.kind = KIND_NAMES[timeline.sectionKinds?.[frame] ?? 1];
    arcInput.tension = timeline.sampleAt('tension', t);
    arcInput.imminence = timeline.sampleAt('imminence', t);
    arcInput.release = timeline.sampleAt('release', t);
    arcInput.energy = timeline.sampleAt('energySlow', t);
    arcInput.sectionIndex = timeline.sectionIndex?.[frame] ?? 0;
    return arcInput;
  }

  return {
    timeline,
    preset,
    arc: arc.state,
    emitters: system.emitters,

    get paletteName() {
      return palette.name;
    },
    setPalette(name) {
      palette = createPalette(name, rng);
    },

    get syncOffset() {
      return syncOffset;
    },
    set syncOffset(v) {
      syncOffset = v;
      timeline.resetCursor(Math.max(0, tPrev + v));
    },

    /** Call on seek, on load, and before frame 0 of a render. */
    reset(t = 0) {
      reader.reset();
      system.reset();
      arc.reset();
      flow.reset();
      hits.reset();
      feel.reset();
      const tRead = Math.max(0, t + syncOffset);
      timeline.resetCursor(tRead);
      tPrev = tRead;
      lastTransients = { radiusBoost: 0, bloomFlash: 0 };
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

      const a = arc.update(readArc(tRead), dt);

      feel.apply(sim, f, dt, lastTransients, a);
      lastTransients = hits.apply(sim, f, dt, palette, timeline, a);
      flow.apply(sim, f, dt, palette, a);

      return f;
    },

    get features() {
      return reader.features;
    }
  };
}

const KIND_NAMES = ['quiet', 'mid', 'high'];
