/**
 * Where a sound belongs on screen, and how it should move there.
 *
 * Four continuous properties decide it — pitch, how noisy it is, how long it sustains, and
 * how much of it arrived — and every part of the answer is a smooth function of them. There
 * is no bucket for a sound to fall into wrongly, which is the failure that had a kick drawn
 * as a hi-hat whenever clustering split it across two groups.
 *
 * Two sounds agreeing on all of these still look alike. That is the mapping working rather
 * than failing: if they agree on every axis, they sound alike too. What it cannot separate
 * is sounds differing along something none of them measures — two voices on the same note,
 * say, which differ in harmonic structure alone.
 */
import { clamp01 } from './smoothers.js';

/**
 * Where a sound lives and how it moves.
 *
 * The frame is a map with two axes you can read off it: height is pitch, across is how
 * long the sound sustains. Short and sharp on the left, ringing on the right. Both need no
 * explaining once seen, and because both are measured from the sound itself, a recurring
 * sound returns to exactly the same place every time.
 *
 * Height was pitch from the start; horizontal used to be a serpentine *also* in pitch,
 * which existed only to stop a straight sweep putting every hit on one diagonal line. That
 * was an arbitrary fold carrying no information, and it left two sounds at the same pitch
 * sitting on top of each other however differently they behaved. A second real axis solves
 * the diagonal properly and separates them.
 *
 * Sustain is curved before it is used as a position. Measured sustain is physical and so
 * genuinely lopsided — the median onset sits at 0.14 on the EDM track — which would crowd
 * most of a track into the left margin. This curve spreads that median to 0.45 while
 * leaving the order and both endpoints untouched.
 *
 * A power curve does the same job and was the first choice, but its slope at zero is
 * infinite: two of the shortest sounds in a track, measured a thousandth apart, landed 7%
 * of the frame apart. Zero is exactly where measurement noise lives, so the mapping has to
 * be gentlest there, not steepest. This one has a finite slope everywhere.
 */
const SUSTAIN_KNEE = 0.25;
const spreadSustain = (d) => (d * (1 + SUSTAIN_KNEE)) / (d + SUSTAIN_KNEE);

export function shapeOf(pitch, noise = 0.5, decay = 0) {
  const p = clamp01(pitch);
  return {
    x: 0.1 + 0.8 * spreadSustain(clamp01(decay)),
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
