/**
 * FLOW — the continuous layer, riding the physical emitters.
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

const BANDS_FULL = ['bassDrive', 'bassDrive', 'mid', 'mid', 'trebleFast', 'trebleFast'];
// Nothing in the low end to drive the first emitters, so shift everything up a band.
const BANDS_SPARSE = ['mid', 'mid', 'mid', 'centroidEnergy', 'trebleFast', 'trebleFast'];

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
    const bands = f.profile === 'sparse' ? BANDS_SPARSE : BANDS_FULL;
    const force = config.force ?? 220;
    const gate = config.gate ?? 0.06;

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
      emitRound(sim, f, palette, arc, aspect, bands, force, gate);
    }
  }

  function emitRound(sim, f, palette, arc, aspect, bands, force, gate) {

    /**
     * Dynamic range lives here. In a quiet section arc.intensity falls to ~0.2, most
     * emitters drop below the gate, and the screen genuinely empties out — which is the
     * only thing that makes the loud sections land.
     */
    const active = Math.max(1, Math.round(system.emitters.length * (0.35 + 0.65 * arc.intensity)));

    for (let i = 0; i < system.emitters.length; i++) {
      if (i >= active) continue;
      const e = system.emitters[i];

      const band = bands[i % bands.length];
      const raw = band === 'centroidEnergy' ? f.centroid * f.rms : f[band];

      // A held note keeps pushing even when nothing is attacking — without this a
      // drumless track goes still between phrases. e.energy carries recent hits, so an
      // emitter that was just struck keeps glowing for a moment.
      const drive =
        (Math.max(0, raw - gate) + (config.sustainDrive ?? 0.6) * f.sustain + e.energy * 0.5) *
        arc.intensity;
      if (drive <= 0.004) continue;

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

      // Held deliberately low: six emitters at 60Hz is ~360 splats/sec, so each has to be
      // far fainter than a mouse splat or the screen fills within a couple of seconds.
      const dye = (0.012 + 0.05 * Math.pow(clamp01(drive), 0.8)) * (0.4 + 0.9 * arc.intensity);
      palette.colorAt(clamp01(f.centroid + i * 0.03), dye, color, arc.hueOffset);

      sim.splat(e.x, e.y, rx * mag, ry * mag, color);
    }

    if (config.curtain) applyCurtain(sim, f, 1, palette, aspect, arc);
    applyIdleBed(sim, f, 1, palette, arc, system.time);
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
    const drift = Math.sin(T * 0.23) * 0.06;
    const amount = (1 - quiet / 0.45) * k;
    palette.colorAt(f.centroid, 0.012 * amount, color, arc.hueOffset);
    sim.splat(0.38 + drift, 0.5 - drift * 0.5, 28 * amount, 9 * amount, color);
    sim.splat(0.62 - drift, 0.5 + drift * 0.5, -28 * amount, -9 * amount, color);
  }

  return { apply, reset };
}
