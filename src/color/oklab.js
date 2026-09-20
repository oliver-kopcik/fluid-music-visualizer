/**
 * OKLCH → sRGB, for building palette lookup tables.
 *
 * Interpolating between saturated hues in linear RGB goes through mud: blue→yellow passes
 * through grey, magenta→green through brown. Under a bloom-heavy fluid those dull midpoints
 * are exactly what you see most of, because most pixels are between two splats rather than
 * inside one. OKLab keeps the path perceptually even, so the gradients stay vivid.
 *
 * Conversion is done once per palette at load, never per splat.
 */

function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Returns *linear* RGB, not gamma-encoded sRGB.
 *
 * The fluid shader treats dye as linear light — it adds splats together and the display
 * shader applies its own curve. Handing it gamma-encoded values makes overlapping splats
 * sum wrongly and everything reads washed out.
 */
export function oklchToLinearRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const [r, g, b] = oklabToLinearSrgb(L, C * Math.cos(h), C * Math.sin(h));
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/** Shortest-path hue interpolation, so a palette can wrap past 360°. */
export function lerpHue(h1, h2, t) {
  let d = ((h2 - h1 + 540) % 360) - 180;
  return (h1 + d * t + 360) % 360;
}
