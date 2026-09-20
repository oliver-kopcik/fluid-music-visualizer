/**
 * HITS — the percussive layer. One gesture per onset, shaped by what the sound is.
 *
 * These are true impulses and are deliberately NOT dt-scaled: a kick is one event, and
 * scaling it by frame time would make it land harder at low frame rates.
 *
 * How each one looks comes from the onset's own pitch and strength, continuously (see
 * gesture.js). Before this, every onset went through three hardcoded shapes keyed only on
 * low-versus-high, so a hat, a clap and a synth stab were all drawn identically; the
 * version after that grouped sounds into clusters and gave each cluster a fixed gesture,
 * which failed differently — whichever cluster the kick landed in decided whether half the
 * beats were visible.
 */
import { clamp01 } from './smoothers.js';
import { emitOnset, shapeOf, ringAmplitudeAt, ringSecondsFor } from './gesture.js';

const MAX_SPLATS_PER_FRAME = 22;

/**
 * Rapid re-triggering is attenuated within a register rather than globally.
 *
 * A global refractory dimmed a snare to 35% because a hat had landed 80ms earlier — two
 * different sounds treated as one repeated sound. Keyed on pitch, a busy hat pattern still
 * damps itself without touching anything below it.
 */
const REGISTERS = 8;
const registerOf = (pitch) => Math.min(REGISTERS - 1, Math.max(0, Math.round(clamp01(pitch) * (REGISTERS - 1))));

/**
 * Rings advance on a fixed 60Hz clock, like FLOW and for the same reason: a half-strength
 * splat still paints a full-size disc, so emitting once per rendered frame would make a
 * 165Hz display lay down nearly three times the coverage of a 60Hz one and the preview
 * would not match the export.
 */
const RING_RATE = 1 / 60;
const MAX_RINGS = 4;

export function createHits(config, rng, system) {
  const color = { r: 0, g: 0, b: 0 };
  const lastFired = new Float32Array(REGISTERS).fill(-999);
  /** Hits still ringing. Oldest is dropped first, so a dense passage stays bounded. */
  const rings = [];
  let ringAccumulator = 0;
  let radiusBoost = 0;
  let bloomFlash = 0;

  function reset() {
    radiusBoost = 0;
    bloomFlash = 0;
    lastFired.fill(-999);
    rings.length = 0;
    ringAccumulator = 0;
  }

  function apply(sim, f, dt, palette, timeline, arc) {
    radiusBoost = 0;
    bloomFlash = 0;

    const aspect = sim.canvas.width / sim.canvas.height;
    advanceRings(sim, dt, palette, arc, aspect);

    if (f.onsets.length === 0) return { radiusBoost, bloomFlash };

    const baseForce = config.force ?? (f.profile === 'sparse' ? 1400 : 2400);
    const gain = 0.35 + 0.75 * arc.intensity;

    // Strongest first, so the cap drops the least important hits rather than the last ones.
    const ordered = [...f.onsets].sort((a, b) => b.strength - a.strength);
    let budget = MAX_SPLATS_PER_FRAME;

    for (const onset of ordered) {
      if (budget <= 0) break;

      const pitch = onset.pitch ?? 0.5;
      const reg = registerOf(pitch);
      let s = clamp01(onset.strength);

      let attenuation = 1;
      if (f.t - lastFired[reg] < 0.11) {
        attenuation = 0.4;
        s *= 0.45;
      }
      lastFired[reg] = f.t;

      const result = emitOnset(sim, {
        pitch,
        noise: onset.noise ?? 0.5,
        decay: onset.decay ?? 0,
        strength: s,
        palette,
        arc,
        aspect,
        rng,
        baseForce: baseForce * gain * attenuation,
        colorOut: color
      });
      budget -= result.splats;
      radiusBoost = Math.max(radiusBoost, result.radiusBoost);

      // Sounds that ring keep pushing as they fade. The shortest sounds in the track get
      // no tail at all, which is what lets a longer one read as ringing beside them.
      if (ringSecondsFor(onset.decay ?? 0) > 0) {
        if (rings.length >= MAX_RINGS) rings.shift();
        rings.push({ pitch, noise: onset.noise ?? 0.5, strength: s, decay: onset.decay, age: 0 });
      }

      // Downbeats get an extra flash; the grid is only trusted when hits land on it.
      if (timeline.gridUsable && timeline.nearestDownbeatDistance(onset.t) < 0.06) {
        bloomFlash = Math.max(bloomFlash, 0.45 * s);
        system.torque(1.4 * s);
      }
    }

    return { radiusBoost, bloomFlash };
  }

  function advanceRings(sim, dt, palette, arc, aspect) {
    if (!rings.length) {
      ringAccumulator = 0;
      return;
    }
    ringAccumulator += dt;
    // Cap the catch-up so a stall does not dump a burst of splats on the next frame.
    const rounds = Math.min(2, Math.floor(ringAccumulator / RING_RATE));
    if (rounds === 0) return;
    ringAccumulator -= rounds * RING_RATE;

    const baseForce = 2400;
    for (let r = 0; r < rounds; r++) {
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.age += RING_RATE;
        const amp = ringAmplitudeAt(ring.decay, ring.age);
        if (amp <= 0) {
          rings.splice(i, 1);
          continue;
        }
        emitOnset(sim, {
          pitch: ring.pitch,
          noise: ring.noise,
          decay: ring.decay,
          strength: ring.strength,
          palette,
          arc,
          aspect,
          rng,
          baseForce,
          colorOut: color,
          ring: amp
        });
      }
    }
  }

  return { apply, reset, shapeOf };
}
