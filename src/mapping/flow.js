/**
 * FLOW — the continuous layer. Constant motion proportional to band energy.
 *
 * Six emitters ride a slowly wobbling ring, each bound to a frequency band. Low emitters
 * read the slow envelope so bass reads as body; high emitters read the fast one so treble
 * reads as shimmer.
 *
 * Two details carry most of the visual quality:
 *
 * - Tangential direction alternates sign by emitter index. With a single direction the
 *   whole frame becomes one lazy global swirl; alternating produces counter-rotating
 *   vortex pairs that shear against each other, which is what the fluid solver is
 *   actually good at showing.
 *
 * - Everything scales by dt/(1/60). splat() is an impulse, not a rate, so without this a
 *   30fps preview deposits half the momentum per second that a 60fps export does, and the
 *   two stop matching.
 */
import { clamp, clamp01 } from './smoothers.js';

const REFERENCE_DT = 1 / 60;

const BANDS_FULL = ['bassSlow', 'bassSlow', 'mid', 'mid', 'trebleFast', 'trebleFast'];
// Nothing in the low end to drive the first emitters, so shift everything up a band.
const BANDS_SPARSE = ['mid', 'mid', 'mid', 'centroidEnergy', 'trebleFast', 'trebleFast'];

export function createFlow(config, rng) {
  const K = config.emitters ?? 6;
  const emitters = [];
  for (let i = 0; i < K; i++) {
    emitters.push({
      phase: (i * 2 * Math.PI) / K + rng() * 0.3,
      radius: 0.22 + 0.1 * (i / K),
      omega: 0.18 + 0.07 * i,
      parity: i % 2 ? 1 : -1
    });
  }

  // Deterministic clock: accumulated dt, never performance.now().
  let T = 0;
  let emitAccumulator = 0;
  const color = { r: 0, g: 0, b: 0 };

  function reset() {
    T = 0;
    emitAccumulator = 0;
  }

  function apply(sim, f, dt, palette, tempoScale = 1) {
    T += dt;

    /**
     * Emit at a fixed 60 Hz rather than once per rendered frame.
     *
     * Scaling dye by dt is not enough on its own: a half-strength splat still paints a
     * full-size disc, so a 157fps display covered the screen 2.6x as fast as a 60fps one
     * even with the same dye per second, and the frame saturated to white. Emitting on a
     * fixed clock fixes the coverage as well as the amount — and it makes the preview and
     * the export produce the same picture by construction, whatever rate each runs at.
     */
    emitAccumulator += dt;
    if (emitAccumulator < REFERENCE_DT) return;
    // Cap the catch-up so a stall doesn't dump a burst of splats on the next frame.
    const rounds = Math.min(2, Math.floor(emitAccumulator / REFERENCE_DT));
    emitAccumulator -= rounds * REFERENCE_DT;

    const k = rounds;
    const aspect = sim.canvas.width / sim.canvas.height;
    const bands = f.profile === 'sparse' ? BANDS_SPARSE : BANDS_FULL;

    const force = config.force ?? 220;
    const gate = config.gate ?? 0.06;

    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i];
      const band = bands[i % bands.length];
      const raw = band === 'centroidEnergy' ? f.centroid * f.rms : f[band];

      // A held note keeps pushing even when nothing is attacking — without this a
      // drumless track goes still between phrases.
      const drive = Math.max(0, raw - gate) + (config.sustainDrive ?? 0.6) * f.sustain;
      if (drive <= 0.001 && f.activity < 0.18) continue;

      const theta = e.phase + e.omega * tempoScale * T;
      const wobble = 0.045 * Math.sin(2.7 * T + 3.1 * i);
      const r = e.radius + wobble;

      // sin scaled by aspect so the ring is a circle on screen, matching splat()'s own
      // aspect correction.
      const x = 0.5 + r * Math.cos(theta);
      const y = 0.5 + r * aspect * Math.sin(theta);
      if (x < 0.02 || x > 0.98 || y < 0.02 || y > 0.98) continue;

      const mag = force * Math.pow(clamp(drive, 0, 2), 1.4) * k;

      let dx = -Math.sin(theta) * e.parity;
      let dy = Math.cos(theta) * aspect * e.parity;
      const radial = 0.35 * Math.sin(0.6 * T + i);
      dx += Math.cos(theta) * radial;
      dy += Math.sin(theta) * aspect * radial;

      // Melodic steering: brightness rising pushes outward, falling pulls in.
      const steer = clamp(f.centroidSlope, -1, 1) * (config.steer ?? 0.9);
      const cs = Math.cos(steer);
      const sn = Math.sin(steer);
      const rx = dx * cs - dy * sn;
      const ry = dx * sn + dy * cs;

      const len = Math.hypot(rx, ry) || 1;
      // Held deliberately low. Upstream splats a handful of times per second on mouse
      // movement; six emitters at 60Hz is ~360/s, so each one has to be far fainter than
      // a mouse splat or the screen fills within a couple of seconds.
      const dye = (0.015 + 0.055 * Math.pow(clamp01(drive), 0.8)) * k;
      palette.colorAt(clamp01(f.centroid + i * 0.03), dye, color);

      sim.splat(x, y, (rx / len) * mag, (ry / len) * mag, color);
    }

    if (config.curtain) applyCurtain(sim, f, k, palette, aspect);
    applyIdleBed(sim, f, k, palette, T);
  }

  /**
   * A row of tiny upward splats along the bottom edge, driven by the 32-band spectrum.
   * Reads as a spectrum without literally drawing bars, for ~0.3ms of extra draw calls.
   */
  function applyCurtain(sim, f, k, palette, aspect) {
    const n = f.spectrum.length;
    for (let j = 0; j < n; j++) {
      const s = f.spectrum[j];
      // 32 splats per emission adds up fast; skip the quiet bins entirely and keep the
      // rest faint, or the curtain alone dominates the dye budget.
      if (s < 0.25) continue;
      const x = (j + 0.5) / n;
      palette.colorAt(j / n, (0.008 + 0.022 * s) * k, color);
      sim.splat(x, 0.02, 0, 90 * s * k * aspect, color);
    }
  }

  /**
   * Two slow counter-rotating splats that never stop. Silence should look calm, not
   * frozen, and a quiet passage with nothing moving reads as a bug.
   */
  function applyIdleBed(sim, f, k, palette, T) {
    if (f.activity > 0.35) return;
    const drift = Math.sin(T * 0.3) * 0.04;
    palette.colorAt(f.centroid, 0.02 * k, color);
    sim.splat(0.35, 0.5 + drift, 45 * k, 12 * k, color);
    sim.splat(0.65, 0.5 - drift, -45 * k, -12 * k, color);
  }

  return { apply, reset, emitters };
}
