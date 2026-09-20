/**
 * How one hit is drawn.
 *
 * Two numbers decide it: where the sound sits in the spectrum, and how hard it hit. Every
 * property of the splat — height, width, direction, count, force, colour — is a smooth
 * function of those, so neighbouring sounds look like neighbours and there is no bucket
 * for a sound to fall into wrongly.
 *
 * This replaced clustering the track's sounds and handing each cluster one of six fixed
 * gestures. Clustering is only as good as its worst boundary: on a dense mix the kick
 * split across two clusters, one of which was handed a two-splat gesture, so the sound
 * landing on half the beats became the faintest thing on screen and the picture read as
 * skipping beats it had in fact detected. A continuous mapping cannot fail that way — a
 * slightly lower sound is simply drawn slightly heavier and slightly lower.
 *
 * The cost, stated plainly: two different sounds at the same pitch and level now look
 * alike, where clustering would have separated them. Noisiness is carried as a third axis
 * to recover most of that — a snare scatters where a bass note does not — but a clap and
 * a snare in the same register will read as the same thing.
 */
import { clamp, clamp01 } from './smoothers.js';

const TAU = Math.PI * 2;

/**
 * Where a sound of this pitch lives and how it moves.
 *
 * Height is pitch, because that mapping needs no explaining. Horizontal position is a
 * smooth serpentine in pitch rather than a straight sweep: a straight sweep plus a height
 * that also follows pitch puts every hit on one diagonal line, whereas folding it uses the
 * whole frame while keeping close pitches close together. It depends on pitch alone, so a
 * recurring sound returns to the same place every time.
 */
export function shapeOf(pitch, noise = 0.5) {
  const p = clamp01(pitch);
  return {
    x: 0.5 + 0.4 * Math.sin(p * 7.6 + 0.8),
    y: 0.12 + 0.76 * p,
    // Low sounds are wide and heavy, high ones tight and light.
    spread: 0.085 - 0.055 * p,
    // Radial at the bottom (a burst outward, which reads as weight), tangential at the
    // top (a curl, which reads as shimmer).
    swirl: p,
    // Noise scatters; a tone keeps its ring.
    scatter: clamp01(noise),
    weight: 1 - p
  };
}

/**
 * Fire one hit. `radiusBoost` comes back so FEEL can fatten this frame's splats — a heavy
 * low sound should be physically wider, not merely brighter.
 */
export function emitOnset(sim, { pitch, noise, strength, palette, arc, aspect, rng, baseForce, colorOut }) {
  const s = clamp01(strength);
  const sh = shapeOf(pitch, noise);

  // Harder hits are drawn with more of everything, not just more force: a loud kick that
  // is only faster looks the same as a quiet one once the dye has spread.
  const n = 3 + Math.round(6 * s);
  const force = baseForce * (0.3 + 0.95 * s) * (0.55 + 0.95 * sh.weight);
  const dye = (0.2 + 0.4 * s) * (0.55 + 0.75 * arc.intensity) * (arc.atmosphere?.dye ?? 1);

  // Hue follows pitch through the palette, so the colour of a hit and its height carry the
  // same information and reinforce each other. Pitch goes in as the palette position only:
  // colorAt adds position and hueOffset, so passing pitch through both wrapped the hue
  // round the palette and put two nearby sounds at opposite ends of it.
  palette.colorAt(clamp01(pitch), dye, colorOut, arc.hueOffset);

  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * TAU + sh.scatter * (rng() - 0.5) * TAU;
    const r = sh.spread * (1 + sh.scatter * 2 * rng());
    const dx = Math.cos(a) * (1 - sh.swirl) - Math.sin(a) * sh.swirl;
    const dy = Math.sin(a) * (1 - sh.swirl) + Math.cos(a) * sh.swirl;
    const speed = force * (0.75 + 0.5 * rng());
    sim.splat(
      clamp(sh.x + r * Math.cos(a), 0.02, 0.98),
      clamp(sh.y + r * Math.sin(a) * aspect, 0.02, 0.98),
      dx * speed,
      dy * aspect * speed,
      colorOut
    );
  }

  return { splats: n, radiusBoost: sh.weight * (0.5 + 1.1 * s) };
}
