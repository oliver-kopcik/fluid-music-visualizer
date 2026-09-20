/**
 * Orchestrates the layers. This is the object renderFrame() calls.
 *
 * ARC runs first and decides the posture — is the track coiling toward something,
 * bursting out of it, or resting — and how much output this moment deserves. Everything
 * downstream reads that, which is what stops a drop from being merely a louder verse.
 *
 * Then FEEL, so the splat radius and dissipation this frame's splats land into are right,
 * then FIELD, which is now the only thing that draws: it renders whatever rose in the
 * spectrum since a fixed moment ago. HITS and FLOW are gone — see field.js for why one
 * measurement replaced a detector and two layers.
 */
import { createFeatureReader } from './features.js';
import { Envelope } from './smoothers.js';
import { createArc } from './arc.js';
import { createField } from './field.js';
import { createFeel } from './feel.js';
import { createPalette, createBlendedPalette } from '../color/palettes.js';
import { assignAtmospheres, ATMOSPHERES, ATMOSPHERE_NAMES } from './atmospheres.js';

export function createMapping({ timeline, preset, rng }) {
  const reader = createFeatureReader();

  // Each section is matched to the atmosphere whose character fits its measurements.
  const atmosphereIndex = assignAtmospheres(timeline.sectionStats ?? {}, timeline.sectionCount ?? 0);
  const arc = createArc(atmosphereIndex);
  const field = createField(preset.field ?? {}, rng);
  const feel = createFeel(preset.feel ?? {});
  /**
   * The atmosphere owns colour identity unless something overrides it.
   *
   * Held as a name rather than a built palette so the UI can change it mid-playback; the
   * first version resolved this once at construction and setPalette silently did nothing.
   */
  let overrideName = preset.color?.palette && preset.color.palette !== 'auto' ? preset.color.palette : null;
  let fixedPalette = overrideName ? createPalette(overrideName, rng) : null;
  let blended = createBlendedPalette('spectral', 'spectral', rng);
  let paletteFrom = null;
  let paletteTo = null;

  let lastTransients = { radiusBoost: 0, bloomFlash: 0 };

  /**
   * How much the visuals should be driven right now, 0..1.
   *
   * Once a track ends, currentTime clamps to the duration and the mapping would otherwise
   * go on reading that final frame forever. The idle bed exists so silence reads as calm
   * rather than frozen, but it fires whenever activity is low — which after the end of a
   * track is always — so two splats kept circling indefinitely on any track not ending in
   * a loud section. Winding this down when playback stops lets the picture settle and the
   * dye dissipate, and it comes straight back on resume.
   */
  const liveness = new Envelope(0.25, 1.2, 1);

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
    readers: field.readers,

    get paletteName() {
      return fixedPalette ? fixedPalette.name : blended.name;
    },
    get atmosphereName() {
      return arc.state.atmosphereName;
    },
    /** Pass 'auto' to hand colour back to the atmospheres. */
    setPalette(name) {
      overrideName = !name || name === 'auto' ? null : name;
      fixedPalette = overrideName ? createPalette(overrideName, rng) : null;
      preset.color = { ...preset.color, palette: name || 'auto' };
    },
    get paletteOverride() {
      return overrideName;
    },

    /** Force one atmosphere everywhere, or pass null to follow the sections again. */
    forceAtmosphere(name) {
      arc.force(name);
    },

    /** Section spans plus their chosen atmosphere, for the seek bar. */
    get sections() {
      const bounds = timeline.sectionBounds ?? [];
      const out = [];
      for (let i = 0; i < (timeline.sectionCount ?? 0); i++) {
        const name = ATMOSPHERE_NAMES[atmosphereIndex[i]] ?? 'aurora';
        out.push({
          index: i,
          start: bounds[i] ?? 0,
          end: bounds[i + 1] ?? timeline.duration,
          atmosphere: name,
          swatch: ATMOSPHERES[name]?.swatch ?? '#666'
        });
      }
      return out;
    },

    get syncOffset() {
      return syncOffset;
    },
    set syncOffset(v) {
      syncOffset = v;
    },

    /** Call on seek, on load, and before frame 0 of a render. */
    reset(t = 0) {
      reader.reset();
      arc.reset();
      field.reset();
      feel.reset();
      lastTransients = { radiusBoost: 0, bloomFlash: 0 };
    },

    applyFrame(sim, ctxFeatures, t, dt) {
      // Everything reads the timeline at the shifted time, so the rise being drawn and
      // the structure being read describe the same instant.
      const tRead = Math.max(0, t + syncOffset);

      const f = reader.read(timeline, tRead, dt, ctxFeatures?.live ?? null);

      const a = arc.update(readArc(tRead), dt);

      /**
       * Defaults to driving. Only an explicit `playing: false` winds it down, so headless
       * callers — the test suites, and the offline renderer — work without having to know
       * about playback state at all. Getting this backwards silently gated off every
       * splat, including in the tests.
       */
      const live = liveness.step(ctxFeatures?.playing === false ? 0 : 1, dt);
      a.liveness = live;
      a.intensity *= live;
      // Below this nothing is visible anyway; stop drawing so the fluid can settle.
      if (live < 0.02) return f;

      // Rebuild the cross-fade only when the atmosphere pair actually changes; setMix is
      // the per-frame part and is free.
      let palette = fixedPalette;
      if (!palette) {
        if (a.atmosphere.from !== paletteFrom || a.atmosphere.to !== paletteTo) {
          paletteFrom = a.atmosphere.from;
          paletteTo = a.atmosphere.to;
          blended = createBlendedPalette(paletteFrom, paletteTo, rng);
        }
        blended.setMix(a.atmosphere.mix);
        palette = blended;
      }

      feel.apply(sim, f, dt, lastTransients, a);
      lastTransients = field.apply(sim, f, dt, palette, timeline, a);

      return f;
    },

    get features() {
      return reader.features;
    }
  };
}

const KIND_NAMES = ['quiet', 'mid', 'high'];
