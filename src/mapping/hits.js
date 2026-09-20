/**
 * HITS — the percussive layer. One burst per detected onset.
 *
 * These are true impulses and are deliberately NOT dt-scaled: a kick is one event, and
 * scaling it by frame time would make it land harder at low frame rates.
 *
 * Shapes differ by band because the fluid shows them differently:
 *   kick  — outward radial burst plus a one-frame splat-radius bump, which is what makes
 *           it feel fat rather than just bright.
 *   snare — two splats fired head-on at each other; the collision produces a sharp shear
 *           line that reads as a crack.
 */
import { clamp, clamp01 } from './smoothers.js';

const MAX_SPLATS_PER_FRAME = 16;

export function createHits(config, rng, system) {
  const color = { r: 0, g: 0, b: 0 };
  // Reused scratch, so a busy passage does not allocate an array per frame.
  const ordered = [];
  let sinceOnset = 999;
  let radiusBoost = 0;
  let bloomFlash = 0;

  function reset() {
    sinceOnset = 999;
    radiusBoost = 0;
    bloomFlash = 0;
  }

  function apply(sim, f, dt, palette, timeline, arc) {
    sinceOnset += dt;
    radiusBoost = 0;
    bloomFlash = 0;

    if (f.onsets.length === 0) return { radiusBoost, bloomFlash };

    // Quiet sections get gentler hits, so the loud ones have somewhere to go.
    const gain = 0.35 + 0.75 * arc.intensity;

    const aspect = sim.canvas.width / sim.canvas.height;
    const baseForce = config.force ?? (f.profile === 'sparse' ? 1400 : 2400);

    // A dense hat pattern will otherwise wash the frame out within four bars.
    ordered.length = 0;
    for (let i = 0; i < f.onsets.length; i++) ordered.push(f.onsets[i]);
    ordered.sort((a, b) => b.strength - a.strength);
    let budget = MAX_SPLATS_PER_FRAME;

    for (const onset of ordered) {
      if (budget <= 0) break;

      let s = clamp01(onset.strength);
      let force = baseForce * (0.25 + 0.75 * s);

      // Rapid re-triggering means hats, not hits. Attenuate hard.
      if (sinceOnset < 0.12) {
        force *= 0.35;
        s *= 0.4;
      }
      sinceOnset = 0;

      force *= gain;

      if (onset.band === 'low') budget -= kick(sim, f, s, force, aspect, palette, timeline, arc);
      else if (onset.band === 'high') budget -= snare(sim, f, s, force, aspect, palette, arc);
      else budget -= generic(sim, f, s, force, aspect, palette, arc);

      // Downbeats get an extra centred burst and a bloom flash.
      if (timeline.gridUsable && timeline.nearestDownbeatDistance(onset.t) < 0.06) {
        budget -= downbeat(sim, f, s, force, aspect, palette, arc);
        bloomFlash = Math.max(bloomFlash, 0.45 * s);
      }
    }

    return { radiusBoost, bloomFlash };
  }

  function kick(sim, f, s, force, aspect, palette, timeline, arc) {
    // Walk the burst around the frame by bar position so successive bars don't stack.
    let cx = 0.5;
    let cy = 0.3;
    if (timeline.gridUsable && f.beatIndex >= 0) {
      const barPhase = (((f.beatIndex % 4) + 4) % 4) / 4;
      cx = 0.5 + 0.2 * Math.cos(2 * Math.PI * barPhase);
      cy = 0.5 + 0.2 * aspect * Math.sin(2 * Math.PI * barPhase);
    }

    const n = 5;
    const r = 0.05;
    palette.colorAt(clamp01(f.centroid * 0.6), (0.3 + 0.3 * s) * (0.5 + 0.7 * arc.intensity), color, arc.hueOffset);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + rng() * 0.4;
      const speed = force * (0.8 + 0.4 * rng());
      sim.splat(
        clamp(cx + r * Math.cos(a), 0.02, 0.98),
        clamp(cy + r * aspect * Math.sin(a), 0.02, 0.98),
        Math.cos(a) * speed,
        Math.sin(a) * aspect * speed,
        color
      );
    }

    // Shove the emitters away from the kick. This is what makes the formation react to
    // the music rather than only the dye — the consequence outlives the frame.
    system.impulse(cx, cy, 0.9 * s * (0.4 + 0.8 * arc.intensity), aspect);

    // The transient that gives a kick its weight. Restored by FEEL next frame.
    radiusBoost = Math.max(radiusBoost, 0.6 + 1.2 * s);
    return n;
  }

  function snare(sim, f, s, force, aspect, palette, arc) {
    const spread = 0.18 + 0.12 * s;
    const y = 0.62;
    // Deliberately far around the palette from the flow: hits should read as their own
    // colour punching in, not as a brighter version of what is already there.
    palette.colorAt(clamp01(0.55 + f.centroid * 0.45), (0.22 + 0.26 * s) * (0.5 + 0.7 * arc.intensity), color, arc.hueOffset + 0.4);
    sim.splat(clamp(0.5 - spread, 0.02, 0.98), y, force * 1.1, 0, color);
    sim.splat(clamp(0.5 + spread, 0.02, 0.98), y, -force * 1.1, 0, color);
    return 2;
  }

  function generic(sim, f, s, force, aspect, palette, arc) {
    const x = clamp(0.2 + f.centroid * 0.6, 0.05, 0.95);
    const y = clamp(0.3 + f.rms * 0.4, 0.05, 0.95);
    const a = rng() * 2 * Math.PI;
    palette.colorAt(f.centroid, (0.18 + 0.25 * s) * (0.5 + 0.7 * arc.intensity), color, arc.hueOffset + 0.4);
    sim.splat(x, y, Math.cos(a) * force * 0.8, Math.sin(a) * aspect * force * 0.8, color);
    return 1;
  }

  function downbeat(sim, f, s, force, aspect, palette, arc) {
    const n = 8;
    palette.colorAt(clamp01(f.centroid), (0.28 + 0.26 * s) * (0.5 + 0.7 * arc.intensity), color, arc.hueOffset + 0.2);
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      sim.splat(
        0.5 + 0.02 * Math.cos(a),
        0.5 + 0.02 * aspect * Math.sin(a),
        Math.cos(a) * force * 1.5,
        Math.sin(a) * aspect * force * 1.5,
        color
      );
    }
    // Whip the whole formation round on a downbeat.
    system.torque(1.6 * s);
    return n;
  }

  return { apply, reset };
}
