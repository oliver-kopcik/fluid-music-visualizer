/**
 * Atmospheres: a whole personality per section, not just a brightness.
 *
 * The simulation's own parameters are the strongest expressive tool available here, and
 * they were barely being used — velocity diffusion in particular, which decides whether
 * motion glides on for seconds or dies the instant it starts. That single knob is the
 * difference between something underwater and something percussive, and it was pinned to
 * a narrow band by loudness alone.
 *
 * Each section is measured (weight, brightness, sustain, onset rate, busyness) and matched
 * to the atmosphere whose character fits, then cross-faded in over a couple of seconds.
 * The audio-reactive modulation from FEEL still runs on top; these are the bases it moves
 * around, so a section changes what the fluid *is*, and the music changes what it does.
 *
 * Ranges here are deliberately wider than upstream's GUI allows. Upstream is tuned for
 * mouse splats on a black screen; driven continuously, the interesting territory extends
 * well past those limits.
 */

/**
 * @property velocity  VELOCITY_DISSIPATION. Low = momentum carries, long gliding
 *                     streamers. High = motion dies on contact, staccato and crisp.
 * @property curl      CURL. Vorticity — how much the flow curls into itself.
 * @property pressure  PRESSURE. High = smooth and coherent, low = loose and turbulent.
 * @property density   DENSITY_DISSIPATION. Trail length.
 * @property radius    SPLAT_RADIUS base.
 * @property bloom     BLOOM_INTENSITY base.
 * @property sunrays   SUNRAYS_WEIGHT.
 * @property palette   colour identity.
 * @property flowForce multiplier on FLOW's push.
 */
export const ATMOSPHERES = {
  /** Heavy and slow. Deep bass, little movement up top. Momentum carries a long way. */
  subterranean: {
    label: 'subterranean',
    velocity: 0.06,
    curl: 14,
    pressure: 0.92,
    density: 4.5,
    radius: 0.42,
    bloom: 0.45,
    sunrays: 0.4,
    palette: 'ember',
    flowForce: 0.85,
    want: { weight: 1, sustain: 0.5, onsetRate: -0.6, brightness: -0.8 }
  },

  /** Held, tonal, sparse. Long glides and smooth pressure — the underwater one. */
  glassy: {
    label: 'glassy',
    velocity: 0.04,
    curl: 10,
    pressure: 0.96,
    density: 6.0,
    radius: 0.3,
    bloom: 0.5,
    sunrays: 1.3,
    palette: 'ice',
    flowForce: 0.9,
    want: { sustain: 1.2, onsetRate: -1, busyness: -0.7 }
  },

  /** Bright, light, airy. High centroid with little weight underneath. */
  aurora: {
    label: 'aurora',
    velocity: 0.08,
    curl: 30,
    pressure: 0.88,
    density: 7.0,
    radius: 0.2,
    bloom: 0.7,
    sunrays: 1.5,
    palette: 'spectral',
    flowForce: 1,
    want: { brightness: 1.1, weight: -0.7, energy: 0.2 }
  },

  /** Busy and percussive. Motion dies fast so every hit stays legible. */
  swarm: {
    label: 'swarm',
    velocity: 0.55,
    curl: 58,
    pressure: 0.6,
    density: 9.0,
    radius: 0.16,
    bloom: 0.55,
    sunrays: 0.7,
    palette: 'neon',
    flowForce: 1.15,
    want: { onsetRate: 1.2, busyness: 1, sustain: -0.8 }
  },

  /** Loud, wide, aggressive. The drop. */
  blaze: {
    label: 'blaze',
    velocity: 0.22,
    curl: 46,
    pressure: 0.7,
    density: 5.0,
    radius: 0.36,
    bloom: 0.85,
    sunrays: 1.1,
    palette: 'sunset',
    flowForce: 1.3,
    want: { energy: 1.3, weight: 0.6, brightness: 0.4 }
  },

  /** Near-silence. Almost nothing moves, and what does moves forever. */
  void: {
    label: 'void',
    velocity: 0.03,
    curl: 8,
    pressure: 0.95,
    density: 8.5,
    radius: 0.26,
    bloom: 0.35,
    sunrays: 0.9,
    palette: 'ice',
    flowForce: 0.6,
    want: { energy: -1.5, busyness: -0.5 }
  }
};

export const ATMOSPHERE_NAMES = Object.keys(ATMOSPHERES);

/** Keys blended numerically. Palette is picked, not blended, then cross-faded separately. */
const NUMERIC_KEYS = ['velocity', 'curl', 'pressure', 'density', 'radius', 'bloom', 'sunrays', 'flowForce'];

/**
 * Pick the atmosphere whose wanted character best matches a section.
 *
 * Section stats are z-scored across the track first, so selection is relative: the
 * brightest section of a dark song still reads as the bright one, which is the same
 * reasoning as classifying section energy relative to the track rather than absolutely.
 */
export function assignAtmospheres(stats, count) {
  if (!count) return [];

  const fields = ['energy', 'centroid', 'brightness', 'weight', 'sustain', 'busyness', 'onsetRate'];
  const z = {};
  for (const key of fields) {
    const arr = stats[key];
    if (!arr) {
      z[key] = new Float32Array(count);
      continue;
    }
    let mean = 0;
    for (let i = 0; i < count; i++) mean += arr[i];
    mean /= count;
    let variance = 0;
    for (let i = 0; i < count; i++) variance += (arr[i] - mean) ** 2;
    const sd = Math.sqrt(variance / Math.max(1, count)) || 1e-6;
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = (arr[i] - mean) / sd;
    z[key] = out;
  }

  /**
   * Loudness is deliberately de-emphasised here.
   *
   * The arc already turns section energy into intensity, so letting energy dominate this
   * choice too just doubles up on level and makes every track alternate between the
   * quietest and loudest atmospheres — the drumless track came out void, blaze, void,
   * blaze. Atmosphere is meant to capture *character*: what the section is made of, not
   * how loud it is.
   */
  if (z.energy) for (let i = 0; i < count; i++) z.energy[i] *= 0.55;

  /**
   * Cosine-style scoring: the dot product divided by the want vector's magnitude.
   *
   * A plain dot product rewards atmospheres that simply list more (or larger) preferences,
   * so blaze and void won on weight of coefficients rather than on fit. Normalising
   * compares direction — how well the section's character matches the shape this
   * atmosphere is looking for.
   */
  const norms = ATMOSPHERE_NAMES.map((name) => {
    const want = ATMOSPHERES[name].want;
    let sum = 0;
    for (const key in want) sum += want[key] * want[key];
    return Math.sqrt(sum) || 1;
  });

  const assigned = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    let best = 0;
    let bestScore = -Infinity;
    for (let a = 0; a < ATMOSPHERE_NAMES.length; a++) {
      const want = ATMOSPHERES[ATMOSPHERE_NAMES[a]].want;
      let score = 0;
      for (const key in want) score += want[key] * (z[key]?.[i] ?? 0);
      score /= norms[a];

      // Push away from repeating. A track that sits in one character throughout should
      // still change visibly at its boundaries.
      if (i > 0 && assigned[i - 1] === a) score -= 0.55;
      if (i > 1 && assigned[i - 2] === a) score -= 0.2;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    assigned[i] = best;
  }
  return assigned;
}

/** Linear blend between two atmospheres, written into `out`. */
export function blendAtmospheres(a, b, t, out = {}) {
  const A = ATMOSPHERES[a] ?? ATMOSPHERES.aurora;
  const B = ATMOSPHERES[b] ?? A;
  for (const key of NUMERIC_KEYS) out[key] = A[key] + (B[key] - A[key]) * t;
  out.from = A.palette;
  out.to = B.palette;
  out.mix = t;
  out.label = t < 0.5 ? A.label : B.label;
  return out;
}
