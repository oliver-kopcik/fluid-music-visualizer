/**
 * FLOW — the continuous layer, riding the physical emitters.
 *
 * The emitters never stop. What the music changes is how hard and how brightly each one
 * pushes, not whether it exists.
 *
 * Each emitter splats along its own motion: the velocity it injects is the direction it
 * is actually travelling, so the dye follows the emitter's path instead of being pushed
 * along a formula. When a kick throws the emitters outward, the dye is visibly thrown
 * with them.
 *
 * Emission runs on a fixed 60Hz clock rather than once per rendered frame. Scaling dye by
 * dt is not enough on its own — a half-strength splat still paints a full-size disc, so a
 * 157fps display covered the screen 2.6x as fast as a 60fps one. A fixed clock fixes
 * coverage as well as amount, and makes the preview and the export agree by construction.
 */
import { clamp, clamp01 } from './smoothers.js';

const REFERENCE_DT = 1 / 60;

/**
 * Read the spectrum as a curve, not as a set of bins.
 *
 * The FFT hands back 32 numbers, but nothing downstream should ever be assigned "bins 5
 * to 10" — that is a bucket, and buckets are what this whole mapping exists to avoid. An
 * emitter sits at a real-valued position on the frequency axis and reads the curve around
 * it with a smooth weighting, so moving an emitter a hair changes its level a hair, and
 * two neighbouring emitters overlap rather than meeting at an edge.
 *
 * The axis is log-spaced from 40Hz to 16kHz, the same one onset pitch is measured on, so
 * an emitter's position and a hit's height mean the same thing.
 */
const READ_WIDTH = 2.2;

function sampleCurve(values, position) {
  const n = values.length;
  const centre = clamp01(position) * (n - 1);
  const from = Math.max(0, Math.floor(centre - READ_WIDTH * 2));
  const to = Math.min(n - 1, Math.ceil(centre + READ_WIDTH * 2));
  let sum = 0;
  let weight = 0;
  for (let b = from; b <= to; b++) {
    const d = (b - centre) / READ_WIDTH;
    const w = Math.exp(-0.5 * d * d);
    sum += values[b] * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : 0;
}

/**
 * Low frequencies respond slowly and high ones quickly, which is the difference between
 * body and shimmer. Carried over from the bassSlow/trebleFast pairing the named bands had.
 */
const tauFor = (position) => 0.22 - 0.19 * position;

export function createFlow(config, rng, system) {
  let emitAccumulator = 0;
  const color = { r: 0, g: 0, b: 0 };

  function reset() {
    emitAccumulator = 0;
  }

  function apply(sim, f, dt, palette, arc) {
    emitAccumulator += dt;
    if (emitAccumulator < REFERENCE_DT) return;
    // Cap the catch-up so a stall doesn't dump a burst of splats on the next frame.
    const rounds = Math.min(2, Math.floor(emitAccumulator / REFERENCE_DT));
    emitAccumulator -= rounds * REFERENCE_DT;

    const aspect = sim.canvas.width / sim.canvas.height;
    const force = config.force ?? 220;
    const gate = config.gate ?? 0.06;
    // Higher-dissipation atmospheres deposit more, or they would simply be darker rather
    // than more abrupt. See the `dye` note in atmospheres.js.
    const dyeScale = arc.atmosphere?.dye ?? 1;

    const swirl = 2.5 + 9 * arc.coil + 5 * arc.burst;

    /**
     * Each round steps the physics AND emits, rather than emitting once with a doubled
     * amount. Doubling gets the dye quantity right but not the coverage — a 30fps preview
     * would lay down 30 discs per second where a 60fps export lays 60, so the two would
     * not actually match. Stepping and emitting together means the splats land at the
     * positions the emitters genuinely passed through, at any frame rate.
     */
    for (let r = 0; r < rounds; r++) {
      system.step(arc.formation, aspect, REFERENCE_DT, swirl);
      emitRound(sim, f, palette, arc, aspect, force, gate, dyeScale);
    }
  }

  function emitRound(sim, f, palette, arc, aspect, force, gate, dyeScale) {

    /**
     * Every emitter emits on every round, always.
     *
     * Dynamic range used to come from switching emitters off: a count gated on
     * arc.intensity, and a hard cutoff below which an emitter contributed nothing. That
     * reads as the picture stopping and restarting rather than as the music getting
     * quieter, and it made quiet passages look broken rather than calm. Volume now maps
     * onto how far and how brightly each emitter pushes, continuously, with a floor that
     * keeps a faint stir under silence. The loud sections still land, because the range
     * between the floor and a full-level emitter is large.
     */
    const floor = config.floor ?? 0.05;

    for (let i = 0; i < system.emitters.length; i++) {
      const e = system.emitters[i];

      // Where this emitter sits on the frequency axis, and what the curve reads there.
      // Spread across the whole range, so no two emitters share a value.
      const position = (i + 0.5) / system.emitters.length;
      const raw = sampleCurve(f.spectrum, position);
      e.level += (raw - e.level) * (1 - Math.exp(-REFERENCE_DT / tauFor(position)));

      // A held note keeps pushing even when nothing is attacking — without this a
      // drumless track goes still between phrases. e.energy carries recent hits, so an
      // emitter that was just struck keeps glowing for a moment.
      const level =
        Math.max(0, e.level - gate) + (config.sustainDrive ?? 0.6) * f.sustain + e.energy * 0.5;
      const drive = floor + level * (0.35 + 0.65 * arc.intensity);

      // Direction of travel, not a formula. This is what ties the dye to the physics.
      let dx = e.x - e.prevX;
      let dy = e.y - e.prevY;
      let len = Math.hypot(dx, dy);
      if (len < 1e-5) {
        // Barely moving: fall back to a tangent so a resting emitter still stirs.
        dx = -(e.y - 0.5);
        dy = e.x - 0.5;
        len = Math.hypot(dx, dy) || 1;
      }

      // Melodic steering: brightness rising sweeps the flow outward, falling pulls it in.
      const steer = clamp(f.centroidSlope, -1, 1) * (config.steer ?? 0.9);
      const cs = Math.cos(steer);
      const sn = Math.sin(steer);
      const rx = (dx * cs - dy * sn) / len;
      const ry = (dx * sn + dy * cs) / len;

      const mag =
        force *
        (arc.atmosphere?.flowForce ?? 1) *
        Math.pow(clamp(drive, 0, 2), 1.3) *
        (0.6 + 1.1 * arc.intensity);

      // Held deliberately low: six emitters at 60Hz is ~360 splats/sec, and they now run
      // without pause, so each has to be far fainter than a mouse splat or the screen
      // fills within a couple of seconds.
      const dye = (0.006 + 0.05 * Math.pow(clamp01(drive), 0.8)) * (0.35 + 0.9 * arc.intensity) * dyeScale;
      // Colour from this emitter's own frequency, not the track's global centroid: with a
      // shared centroid all six came out the same hue whatever they were each carrying.
      palette.colorAt(position, dye, color, arc.hueOffset);

      sim.splat(e.x, e.y, rx * mag, ry * mag, color);
    }

    if (config.curtain) applyCurtain(sim, f, dyeScale, palette, aspect, arc);
    applyIdleBed(sim, f, dyeScale, palette, arc, system.time);
  }

  /**
   * A row of tiny upward splats along the bottom edge, driven by the 32-band spectrum.
   * Reads as a spectrum without literally drawing bars.
   */
  function applyCurtain(sim, f, k, palette, aspect, arc) {
    const n = f.spectrum.length;
    for (let j = 0; j < n; j++) {
      const s = f.spectrum[j] * arc.intensity;
      // 32 splats per emission adds up fast; skip the quiet bins, keep the rest faint.
      if (s < 0.25) continue;
      const x = (j + 0.5) / n;
      palette.colorAt(j / n, (0.008 + 0.022 * s) * k, color, arc.hueOffset);
      sim.splat(x, 0.02, 0, 90 * s * k * aspect, color);
    }
  }

  /**
   * One slow wandering stir that never quite stops. Silence should read as calm, not
   * frozen — but it is deliberately feeble, because a quiet section that still looks busy
   * is exactly what stops the loud ones from landing.
   */
  function applyIdleBed(sim, f, k, palette, arc, T) {
    // Keyed on the audio itself as well as the arc: intensity is derived, and if it is
    // ever wrong (it was, on silence) the fallback that guarantees motion must not be
    // disabled by the same mistake.
    const quiet = Math.max(arc.intensity, f.activity * 1.4);
    if (quiet > 0.45) return;
    // The bed is for quiet *passages*, not for after the track has finished.
    if ((arc.liveness ?? 1) < 0.5) return;
    const drift = Math.sin(T * 0.23) * 0.06;
    const amount = (1 - quiet / 0.45) * k;
    palette.colorAt(f.centroid, 0.012 * amount, color, arc.hueOffset);
    sim.splat(0.38 + drift, 0.5 - drift * 0.5, 28 * amount, 9 * amount, color);
    sim.splat(0.62 - drift, 0.5 + drift * 0.5, -28 * amount, -9 * amount, color);
  }

  return { apply, reset };
}
