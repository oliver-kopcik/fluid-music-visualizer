/**
 * The picture is the change in the sound.
 *
 * Every frame, each point on the frequency axis is compared with where it was a fixed
 * moment earlier, and whatever rose is drawn. That is the whole mechanism. A kick is a
 * large rise near the bottom of the range and draws itself as one; a hi-hat is a small
 * broad rise near the top. Nothing decides whether a sound "counts" first.
 *
 * This replaced a detector plus two layers. Onsets were found by thresholding spectral
 * flux, labelled, ranked, assigned gestures and fired as impulses, while a second layer
 * separately drew the levels underneath them. Every bug worth the name in this mapping
 * came from that first step: a threshold that fired on a synthesised kit and never on real
 * music, a kick split across clusters so half the beats went faint, a sound landing in the
 * wrong bucket and being drawn as something it was not. A rise needs no threshold, cannot
 * be mislabelled and cannot be missed — if the sound changed, the change is on screen, in
 * proportion.
 *
 * The obvious objection is that a sustained note has nothing to draw. Measured across all
 * three test tracks, the longest stretch with audio present and no spectral change is 0.07
 * seconds, including on the drumless vocal stem: real audio is never still at 120fps, and
 * vibrato, breath and room tone keep the curve moving. Digital silence genuinely is still,
 * which is what the idle bed at the bottom of this file is for.
 */
import { clamp, clamp01 } from './smoothers.js';
import { shapeOf } from './gesture.js';

const REFERENCE_DT = 1 / 60;

/**
 * How far back to compare.
 *
 * Fixed in seconds, and read from the analysed spectrogram rather than from whatever was
 * on screen last frame. Diffing against the previous *rendered* frame would make the
 * measurement depend on frame rate — at 165Hz consecutive frames barely differ, at 30Hz
 * they differ hugely — so the same track would be drawn differently on two machines and
 * the preview would not match the export.
 */
const RISE_DELTA = 1 / 60;

const BINS = 32;
/** Width of a reader's view of the curve, in bins. See sampleCurve. */
const READ_WIDTH = 1.6;
/** A second, wider view. How much the two agree is how broadband the rise is. */
const BROAD_WIDTH = 6;

/**
 * Read the curve at a real-valued position, never as a range of bins.
 *
 * The FFT hands back 32 numbers but nothing here is ever assigned "bins 5 to 10" — that is
 * a bucket, and buckets are what this mapping exists to avoid. Moving a reader a hair
 * changes what it sees by a hair, and neighbouring readers overlap rather than meeting at
 * an edge.
 */
function sampleCurve(values, position, width) {
  const centre = clamp01(position) * (values.length - 1);
  const from = Math.max(0, Math.floor(centre - width * 2));
  const to = Math.min(values.length - 1, Math.ceil(centre + width * 2));
  let sum = 0;
  let weight = 0;
  for (let b = from; b <= to; b++) {
    const d = (b - centre) / width;
    const w = Math.exp(-0.5 * d * d);
    sum += values[b] * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

export function createField(config, rng) {
  /**
   * How finely the frequency axis is sampled. Twelve is enough that a kick and the bass
   * note under it land in different places, without the count itself becoming visible as
   * a row of dots.
   */
  const count = config.readers ?? 12;
  const color = { r: 0, g: 0, b: 0 };

  const now = new Float32Array(BINS);
  const before = new Float32Array(BINS);
  const rise = new Float32Array(BINS);

  /**
   * One reader per position on the frequency axis. They hold only what has to persist
   * between frames: the running peak their sustain is measured against, and a wander
   * phase so a row of readers never looks like a row.
   */
  const readers = [];
  for (let i = 0; i < count; i++) {
    readers.push({
      i,
      position: (i + 0.5) / count,
      change: 0,
      mean: 0,
      spikiness: 0,
      sustain: 0.5,
      wanderPhase: rng() * Math.PI * 2,
      wanderRate: 0.3 + rng() * 0.5,
      x: 0.5,
      y: 0.5
    });
  }

  let emitAccumulator = 0;
  let T = 0;
  let lastTransients = { radiusBoost: 0, bloomFlash: 0 };

  function reset() {
    emitAccumulator = 0;
    T = 0;
    lastTransients = { radiusBoost: 0, bloomFlash: 0 };
    for (const r of readers) {
      r.change = 0;
      r.mean = 0;
      r.spikiness = 0;
      r.sustain = 0.5;
    }
  }

  function apply(sim, f, dt, palette, timeline, arc) {
    emitAccumulator += dt;
    if (emitAccumulator < REFERENCE_DT) return lastTransients;
    // Cap the catch-up so a stall does not dump a burst of splats on the next frame.
    const rounds = Math.min(2, Math.floor(emitAccumulator / REFERENCE_DT));
    emitAccumulator -= rounds * REFERENCE_DT;

    timeline.spectrumAt(f.t, now);
    timeline.spectrumAt(Math.max(0, f.t - RISE_DELTA), before);
    // Scaled by what this track calls a strong rise, so a hard transient reads as about 1
    // on any material and the force constants below mean the same thing everywhere.
    const scale = 1 / Math.max(1e-3, timeline.riseReference ?? 1);
    let total = 0;
    for (let b = 0; b < BINS; b++) {
      rise[b] = Math.max(0, now[b] - before[b]) * scale;
      total += rise[b];
    }

    const aspect = sim.canvas.width / sim.canvas.height;
    let radiusBoost = 0;
    for (let r = 0; r < rounds; r++) {
      T += REFERENCE_DT;
      radiusBoost = Math.max(radiusBoost, emitRound(sim, palette, arc, aspect, total));
    }

    lastTransients = {
      radiusBoost,
      // A flash in proportion to how much of the spectrum moved at once, which is what a
      // drum hit is. The flash this replaced keyed on the beat grid, so it did nothing at
      // all on any track whose tempo could not be trusted.
      bloomFlash: clamp01((total - 3) / 6) * 0.5 * arc.intensity
    };
    return lastTransients;
  }

  function emitRound(sim, palette, arc, aspect, total) {
    const force = config.force ?? 2600;
    const floor = config.floor ?? 0.015;
    const dyeScale = arc.atmosphere?.dye ?? 1;
    let radiusBoost = 0;

    /**
     * Nothing anywhere in the spectrum moved, so there is nothing to draw.
     *
     * Tested on the whole frame rather than per reader on purpose. Gating each reader by
     * its own level is what made the picture switch off in quiet passages; this only ever
     * fires on true digital silence, where every reader was otherwise still emitting a
     * splat a tick with a zero-sized rise behind it.
     */
    if (total < 0.02) {
      applyIdleBed(sim, total, palette, arc, dyeScale);
      return radiusBoost;
    }

    /**
     * Sustain is a reader's rank among the others, not its raw restlessness.
     *
     * How spiky a band is has no absolute scale — a busy mix is restless everywhere and a
     * sparse one is calm everywhere — so an absolute cut would push whole tracks into one
     * margin. Ranking asks which of *this* track's frequencies sustain longest, which is
     * the question the axis is meant to answer, and it uses the width of the frame on any
     * material. Ranks are stable because the restlessness they sort is heavily smoothed.
     */
    for (const reader of readers) {
      let rank = 0;
      for (const other of readers) if (other !== reader && other.spikiness > reader.spikiness) rank++;
      const target = readers.length > 1 ? rank / (readers.length - 1) : 0.5;
      reader.sustain += (target - reader.sustain) * 0.05;
    }

    for (const reader of readers) {
      const p = reader.position;
      const amount = sampleCurve(rise, p, READ_WIDTH);
      const level = sampleCurve(now, p, READ_WIDTH);

      /**
       * How restless this frequency is: how much it moves relative to how loud it sits.
       *
       * A band carrying hats swings its whole range every eighth note; a band carrying a
       * pad barely moves. Both are smoothed hard, because this describes the character of
       * a frequency rather than an instant — a percussive band must stay on the percussive
       * side of the frame between hits, not swing across it after every one.
       *
       * The first version measured level against a decaying peak, which reads near 1 for
       * everything in a dense mix: all twelve readers piled into the right-hand margin.
       * A ratio of movement to level is not fooled that way, because a masked band is
       * steady as well as loud.
       */
      reader.change += (Math.abs(level - sampleCurve(before, p, READ_WIDTH)) - reader.change) * 0.02;
      reader.mean += (level - reader.mean) * 0.02;
      reader.spikiness = reader.change / Math.max(1e-4, reader.mean);

      /**
       * Whether this rise is a tone or a noise: how much its neighbours rose with it. A
       * struck string lifts one place on the curve, a snare lifts all of it.
       */
      const broad = sampleCurve(rise, p, BROAD_WIDTH);
      const noise = clamp01(broad / Math.max(1e-4, amount));

      const shape = shapeOf(p, noise, reader.sustain);
      // A slow wander, so a fixed set of positions never reads as a fixed set of points.
      const wobble = 0.035 * Math.sin(T * reader.wanderRate + reader.wanderPhase);
      reader.x = clamp(shape.x + wobble, 0.03, 0.97);
      reader.y = clamp(shape.y + wobble * 0.4, 0.03, 0.97);

      const drive = floor + amount * (0.4 + 0.6 * arc.intensity);
      const n = 1 + Math.round(3 * clamp01(amount));
      const mag =
        force * (arc.atmosphere?.flowForce ?? 1) * Math.pow(clamp(drive, 0, 2), 1.25) * (0.5 + arc.intensity);
      // Nearly all of the dye has to come from the rise. A generous floor meant a reader
      // with nothing happening still laid down colour 60 times a second, which the fluid
      // rendered as a soft round blob sitting in the frame doing nothing.
      const dye = (0.008 + 0.55 * clamp01(drive)) * (0.4 + 0.9 * arc.intensity) * dyeScale;

      palette.colorAt(p, dye, color, arc.hueOffset);

      for (let k = 0; k < n; k++) {
        const a = ((k + 0.5) / n) * Math.PI * 2 + shape.scatter * (rng() - 0.5) * Math.PI * 2;
        const rad = shape.spread * (1 + shape.scatter * 2 * rng());
        const dx = Math.cos(a) * (1 - shape.swirl) - Math.sin(a) * shape.swirl;
        const dy = Math.sin(a) * (1 - shape.swirl) + Math.cos(a) * shape.swirl;
        sim.splat(
          clamp(reader.x + rad * Math.cos(a), 0.02, 0.98),
          clamp(reader.y + rad * Math.sin(a) * aspect, 0.02, 0.98),
          dx * mag,
          dy * aspect * mag,
          color
        );
      }

      // A heavy low rise should physically fatten the splats, not merely brighten them.
      radiusBoost = Math.max(radiusBoost, shape.weight * clamp01(amount) * 1.5);
    }

    applyIdleBed(sim, total, palette, arc, dyeScale);
    return radiusBoost;
  }

  /**
   * Digital silence is the one case with genuinely nothing to draw.
   *
   * Real audio always moves, so this fires only on true silence — the start of a file, a
   * gap between tracks — where the screen would otherwise freeze rather than settle. It is
   * deliberately feeble; a quiet passage that still looks busy is what stops the loud ones
   * landing.
   */
  function applyIdleBed(sim, total, palette, arc, dyeScale) {
    if (total > 0.15) return;
    if ((arc.liveness ?? 1) < 0.5) return;
    const drift = Math.sin(T * 0.23) * 0.06;
    const amount = (1 - total / 0.15) * dyeScale;
    palette.colorAt(0.5, 0.012 * amount, color, arc.hueOffset);
    sim.splat(0.38 + drift, 0.5 - drift * 0.5, 28 * amount, 9 * amount, color);
    sim.splat(0.62 - drift, 0.5 + drift * 0.5, -28 * amount, -9 * amount, color);
  }

  return { apply, reset, readers };
}
