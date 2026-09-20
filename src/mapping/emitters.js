/**
 * Emitters with mass.
 *
 * The first version computed position directly: `theta = phase + omega * T`. That is a
 * clock. Nothing the music did could move an emitter — it only changed how hard the
 * emitter pushed from a position it was always going to be in — and the result read as
 * mechanical no matter how the intensities were tuned.
 *
 * Here each emitter carries position and velocity, is pulled toward a formation by a
 * spring, and is genuinely knocked around by hits. Motion becomes a consequence: a kick
 * throws the emitters outward, they overshoot, they swing back. What happened four bars
 * ago is still visible in where they are now, which is what "alive" actually means.
 *
 * Integrated at a fixed timestep so the physics is identical at any frame rate — and so
 * an export matches the preview exactly.
 */
import { clamp } from './smoothers.js';

/**
 * Formations the spring targets. The arc layer chooses between them, which is how a
 * build and a drop come to look categorically different rather than differently bright.
 */
export const FORMATIONS = {
  /** Wide, lazy ring. The resting state. */
  ring: { radius: 0.3, spin: 0.16, spread: 1, jitter: 0.04 },
  /** Pulled inward and spinning hard — the coil before a drop. */
  coil: { radius: 0.1, spin: 0.85, spread: 0.35, jitter: 0.015 },
  /** Flung wide and fast. */
  burst: { radius: 0.42, spin: 0.42, spread: 1.25, jitter: 0.09 },
  /** Scattered and slow, for near-silence. */
  drift: { radius: 0.34, spin: 0.05, spread: 1.15, jitter: 0.12 }
};

export function createEmitterSystem(count, rng) {
  const emitters = [];
  for (let i = 0; i < count; i++) {
    const angle = (i * 2 * Math.PI) / count + rng() * 0.4;
    emitters.push({
      i,
      angle,
      // Each emitter keeps its own wander phase, so they never move as one rigid body.
      wanderPhase: rng() * Math.PI * 2,
      wanderRate: 0.35 + rng() * 0.5,
      x: 0.5 + 0.3 * Math.cos(angle),
      y: 0.5 + 0.3 * Math.sin(angle),
      vx: 0,
      vy: 0,
      prevX: 0.5,
      prevY: 0.5,
      energy: 0,
      /** This emitter's own smoothed level, from its own slice of the spectrum. */
      level: 0
    });
  }

  let T = 0;

  function reset() {
    T = 0;
    for (const e of emitters) {
      e.x = 0.5 + 0.3 * Math.cos(e.angle);
      e.y = 0.5 + 0.3 * Math.sin(e.angle);
      e.vx = 0;
      e.vy = 0;
      e.energy = 0;
      e.level = 0;
    }
  }

  /**
   * One fixed physics tick.
   *
   * @param formation  blended formation parameters (see blendFormations)
   * @param aspect     canvas aspect, so the formation is a circle on screen
   * @param dt         fixed timestep, not the frame's dt
   */
  function step(formation, aspect, dt, swirl = 0) {
    T += dt;
    const { radius, spin, spread, jitter } = formation;

    for (const e of emitters) {
      e.prevX = e.x;
      e.prevY = e.y;

      e.angle += spin * dt * (1 + 0.25 * Math.sin(e.wanderPhase + T * e.wanderRate));

      // Target: the formation position, plus a slow per-emitter wander so the ring never
      // looks like six points on a rigid wheel.
      const wobble = jitter * Math.sin(T * e.wanderRate * 1.7 + e.wanderPhase);
      const r = radius * spread + wobble;
      const tx = 0.5 + r * Math.cos(e.angle);
      const ty = 0.5 + r * aspect * Math.sin(e.angle);

      // Spring toward the target, with damping. Deliberately loose: a stiff spring just
      // reproduces the old cos(wt) behaviour with extra steps.
      const stiffness = 9;
      const damping = 3.2;
      let ax = (tx - e.x) * stiffness - e.vx * damping;
      let ay = (ty - e.y) * stiffness - e.vy * damping;

      // A global rotational field, so impulses curve instead of travelling in straight
      // lines. Makes the whole system feel like it is swimming rather than being pushed.
      if (swirl !== 0) {
        const dx = e.x - 0.5;
        const dy = e.y - 0.5;
        ax += -dy * swirl;
        ay += dx * swirl;
      }

      e.vx += ax * dt;
      e.vy += ay * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;

      // Soft walls: bounce rather than clamp, so hitting the edge is a visible event.
      if (e.x < 0.04 && e.vx < 0) e.vx = -e.vx * 0.5;
      if (e.x > 0.96 && e.vx > 0) e.vx = -e.vx * 0.5;
      if (e.y < 0.04 && e.vy < 0) e.vy = -e.vy * 0.5;
      if (e.y > 0.96 && e.vy > 0) e.vy = -e.vy * 0.5;
      e.x = clamp(e.x, 0.03, 0.97);
      e.y = clamp(e.y, 0.03, 0.97);

      e.energy *= 0.94;
    }
  }

  /** Shove every emitter away from a point — what a kick does to the formation. */
  function impulse(cx, cy, strength, aspect) {
    for (const e of emitters) {
      const dx = e.x - cx;
      const dy = (e.y - cy) / aspect;
      const d = Math.hypot(dx, dy) || 1e-3;
      // Falls off with distance, but never to nothing: a big hit should move everything.
      const falloff = 0.35 + 0.65 / (1 + d * 6);
      const push = (strength * falloff) / d;
      e.vx += dx * push;
      e.vy += dy * push * aspect;
      e.energy = Math.min(1.5, e.energy + strength * falloff * 2.5);
    }
  }

  /** Spin the whole formation — used on a release, so a drop visibly whips around. */
  function torque(amount) {
    for (const e of emitters) {
      const dx = e.x - 0.5;
      const dy = e.y - 0.5;
      e.vx += -dy * amount;
      e.vy += dx * amount;
    }
  }

  return { emitters, step, impulse, torque, reset, get time() { return T; } };
}

/** Weighted blend of named formations, so transitions are continuous. */
export function blendFormations(weights, out = {}) {
  let radius = 0;
  let spin = 0;
  let spread = 0;
  let jitter = 0;
  let total = 0;
  for (const name in weights) {
    const w = weights[name];
    if (!w) continue;
    const f = FORMATIONS[name];
    radius += f.radius * w;
    spin += f.spin * w;
    spread += f.spread * w;
    jitter += f.jitter * w;
    total += w;
  }
  const inv = total > 0 ? 1 / total : 0;
  out.radius = radius * inv;
  out.spin = spin * inv;
  out.spread = spread * inv;
  out.jitter = jitter * inv;
  return out;
}
