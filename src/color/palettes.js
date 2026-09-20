/**
 * Colour comes from the music: hue follows spectral centroid, so bass is deep and warm
 * and treble is bright and cool, and the picture tells you something about what you are
 * hearing instead of cycling random hues.
 *
 * Each palette is a short list of OKLCH anchors, baked once into a 256-entry LUT.
 */
import { oklchToLinearRgb, lerpHue } from './oklab.js';

const LUT_SIZE = 256;

/** [position 0..1, lightness, chroma, hue°] */
const DEFINITIONS = {
  spectral: [
    [0.0, 0.45, 0.16, 280],
    [0.35, 0.6, 0.2, 340],
    [0.65, 0.72, 0.19, 45],
    [1.0, 0.85, 0.14, 195]
  ],
  ember: [
    [0.0, 0.35, 0.13, 25],
    [0.5, 0.6, 0.19, 45],
    [1.0, 0.88, 0.12, 85]
  ],
  ice: [
    [0.0, 0.4, 0.12, 265],
    [0.55, 0.68, 0.15, 220],
    [1.0, 0.9, 0.09, 190]
  ],
  neon: [
    [0.0, 0.5, 0.24, 320],
    [0.4, 0.62, 0.26, 280],
    [0.7, 0.72, 0.22, 200],
    [1.0, 0.85, 0.2, 150]
  ],
  duotone: [
    [0.0, 0.42, 0.18, 300],
    [1.0, 0.82, 0.17, 95]
  ],
  sunset: [
    [0.0, 0.38, 0.15, 295],
    [0.45, 0.58, 0.21, 10],
    [1.0, 0.86, 0.15, 65]
  ]
};

function buildLut(anchors) {
  const lut = new Float32Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);

    let a = anchors[0];
    let b = anchors[anchors.length - 1];
    for (let k = 0; k < anchors.length - 1; k++) {
      if (t >= anchors[k][0] && t <= anchors[k + 1][0]) {
        a = anchors[k];
        b = anchors[k + 1];
        break;
      }
    }
    const span = Math.max(1e-6, b[0] - a[0]);
    const f = Math.min(1, Math.max(0, (t - a[0]) / span));

    const L = a[1] + (b[1] - a[1]) * f;
    const C = a[2] + (b[2] - a[2]) * f;
    const h = lerpHue(a[3], b[3], f);

    const [r, g, bl] = oklchToLinearRgb(L, C, h);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = bl;
  }
  return lut;
}

const LUTS = {};
for (const [name, anchors] of Object.entries(DEFINITIONS)) LUTS[name] = buildLut(anchors);

export const PALETTE_NAMES = [...Object.keys(DEFINITIONS), 'random'];

/**
 * @param name     palette key, or 'random' for upstream's hue cycling
 * @param rng      used only by 'random'
 */
export function createPalette(name, rng = Math.random) {
  if (name === 'random') {
    return {
      name,
      /** Upstream's behaviour, kept as an option: ignores the audio entirely. */
      colorAt(_position, intensity, out = {}, _hueOffset = 0) {
        const h = rng();
        const [r, g, b] = hsvToRgb(h, 1, 1);
        out.r = r * intensity;
        out.g = g * intensity;
        out.b = b * intensity;
        return out;
      }
    };
  }

  const lut = LUTS[name] ?? LUTS.spectral;
  return {
    name,
    /**
     * @param position  0..1, normally the spectral centroid
     * @param intensity scales the dye deposited; useful range is roughly 0.1-0.6, above
     *                  ~1.0 the dye saturates and bloom blows out
     * @param hueOffset 0..1, rotates where in the palette we read.
     *
     * The arc layer walks hueOffset by a fixed irrational step per section, which is what
     * makes a new section arrive in a new colour. Without it the centroid alone barely
     * moves within a track and every section came out the same hue.
     */
    colorAt(position, intensity, out = {}, hueOffset = 0) {
      const shifted = (position + hueOffset) % 1;
      const i = Math.min(LUT_SIZE - 1, Math.max(0, Math.round(shifted * (LUT_SIZE - 1)))) * 3;
      out.r = lut[i] * intensity;
      out.g = lut[i + 1] * intensity;
      out.b = lut[i + 2] * intensity;
      return out;
    }
  };
}

/**
 * A palette that cross-fades between two others.
 *
 * Section boundaries change the colour identity, and snapping would read as a glitch
 * rather than a transition. Blending the two LUT lookups is cheap and, because both were
 * built through OKLCH, the midpoint stays vivid instead of passing through grey.
 */
export function createBlendedPalette(fromName, toName, rng = Math.random) {
  const a = createPalette(fromName, rng);
  const b = createPalette(toName, rng);
  const tmp = { r: 0, g: 0, b: 0 };
  let mix = 0;
  return {
    get name() {
      return mix < 0.5 ? a.name : b.name;
    },
    setMix(t) {
      mix = t < 0 ? 0 : t > 1 ? 1 : t;
    },
    colorAt(position, intensity, out = {}, hueOffset = 0) {
      a.colorAt(position, intensity, out, hueOffset);
      if (mix <= 0) return out;
      b.colorAt(position, intensity, tmp, hueOffset);
      out.r += (tmp.r - out.r) * mix;
      out.g += (tmp.g - out.g) * mix;
      out.b += (tmp.b - out.b) * mix;
      return out;
    }
  };
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
