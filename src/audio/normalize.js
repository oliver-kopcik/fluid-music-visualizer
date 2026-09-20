/**
 * Turning raw feature values into the 0..1-ish range the mapping layer expects.
 */

/** Percentile of a copy; `values` is left alone. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export const HEADROOM = 1.6;

/**
 * Normalize by p5..p95 rather than min..max.
 *
 * Min/max is what the earlier Python pipeline did, and it has two problems: one loud
 * transient compresses the whole track into the bottom of the range, and every value
 * clips flat at exactly 1.0 so real peaks look identical to merely-loud moments. Robust
 * percentiles plus headroom above 1.0 let genuine peaks overshoot and punch through,
 * which is the single biggest visual-quality difference in the whole pipeline.
 */
export function normalizeRobust(values, out = new Float32Array(values.length)) {
  const lo = percentile(values, 5);
  const hi = percentile(values, 95);
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.min(HEADROOM, Math.max(0, (values[i] - lo) / span));
  }
  return { out, lo, hi };
}

/**
 * Scale by p95 but do NOT clamp.
 *
 * For onset curves the clamp in normalizeRobust is actively harmful: it flattens every
 * real hit to exactly HEADROOM, so peaks lose their relative height and the local-maximum
 * test sees ties everywhere. Detection needs the peaks intact; only the smooth envelopes
 * the mapping layer reads want a bounded range.
 */
export function scaleByP95(values, out = new Float32Array(values.length)) {
  const hi = percentile(values, 95);
  const scale = hi > 1e-9 ? 1 / hi : 0;
  for (let i = 0; i < values.length; i++) out[i] = values[i] * scale;
  return { out, scale };
}

/**
 * Live-path equivalent, for the AnalyserNode detail layer where there is no future to
 * take percentiles over. Asymmetric time constants: follow a rise almost immediately,
 * release slowly, so a loud hit doesn't crush everything after it.
 */
export function createRunningNormalizer({ attack = 0.05, release = 2.0, floor = 1e-4 } = {}) {
  let peak = floor;
  return function normalize(x, dt) {
    const tau = x > peak ? attack : release;
    peak += (x - peak) * (1 - Math.exp(-dt / tau));
    peak = Math.max(peak, floor);
    return Math.min(HEADROOM, x / peak);
  };
}
