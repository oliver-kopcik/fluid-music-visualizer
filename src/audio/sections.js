/**
 * Musical structure: where the sections are, how loud each one is, and — the part that
 * matters most visually — what is about to happen.
 *
 * Without this the visualizer is purely reactive: it can only show how loud the current
 * 8ms of audio is, so a drop looks like a verse with the brightness turned up. Sections
 * let the visuals change *behaviour* at a boundary, and the imminence curve lets them
 * tense before a drop lands instead of only reacting once it has.
 *
 * Anticipation is only possible because the whole track is analysed up front. A live
 * AnalyserNode cannot see forward by even one frame.
 */
import { percentile } from './normalize.js';

/** Sections shorter than this are merged away; below it you get flicker, not structure. */
const MIN_SECTION_SECONDS = 6;

/** How far ahead the visuals may see. Beyond a few seconds, tension stops reading. */
const LOOKAHEAD_SECONDS = 5;

/** Half-width of the windows compared either side of a candidate boundary. */
const NOVELTY_HALF_WINDOW = 2.5;

export function analyzeSections(timelineFields, frameRate) {
  const { rms, bass, mid, treble, centroidNorm } = timelineFields;
  const n = rms.length;

  const energy = smooth(rms, Math.round(0.7 * frameRate));
  const energyLong = smooth(rms, Math.round(3 * frameRate));

  const novelty = noveltyCurve([bass, mid, treble, energy], n, frameRate);
  const boundaries = pickBoundaries(novelty, n, frameRate);
  const sections = describeSections(boundaries, energy, centroidNorm, n, frameRate);

  const sectionIndex = new Int32Array(n);
  const sectionEnergy = new Float32Array(n);
  for (let s = 0; s < sections.length; s++) {
    for (let f = sections[s].startFrame; f < sections[s].endFrame; f++) {
      sectionIndex[f] = s;
      sectionEnergy[f] = sections[s].energy;
    }
  }

  return {
    sectionBounds: Float32Array.from(boundaries, (f) => f / frameRate),
    sectionIndex,
    sectionEnergy,
    sectionCount: sections.length,
    sectionKinds: Uint8Array.from(sectionIndex, (i) => KIND_IDS[sections[i]?.kind ?? 'mid']),
    tension: tensionCurve(energy, frameRate),
    imminence: imminenceCurve(energy, energyLong, frameRate),
    release: releaseCurve(energy, frameRate),
    energySlow: energyLong
  };
}

export const KIND_IDS = { quiet: 0, mid: 1, high: 2 };
export const KIND_NAMES = ['quiet', 'mid', 'high'];

function smooth(x, half) {
  const n = x.length;
  const out = new Float32Array(n);
  if (half < 1) return out.set(x), out;

  // Running sum: an O(n) box filter, applied twice for a smoother kernel.
  let sum = 0;
  for (let i = 0; i < Math.min(n, half); i++) sum += x[i];
  let lo = 0;
  let hi = Math.min(n, half);
  for (let i = 0; i < n; i++) {
    const wantLo = Math.max(0, i - half);
    const wantHi = Math.min(n, i + half + 1);
    while (hi < wantHi) sum += x[hi++];
    while (lo < wantLo) sum -= x[lo++];
    out[i] = sum / Math.max(1, hi - lo);
  }
  return out;
}

/**
 * Distance between the mean feature vector just before and just after each frame.
 *
 * This is the cheap cousin of a self-similarity-matrix novelty curve: for structure at
 * the scale of whole sections, comparing two multi-second windows finds the same
 * boundaries for a fraction of the cost of an n-by-n matrix.
 */
function noveltyCurve(features, n, frameRate) {
  const w = Math.round(NOVELTY_HALF_WINDOW * frameRate);
  const out = new Float32Array(n);
  const prefix = features.map((f) => {
    const p = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) p[i + 1] = p[i] + f[i];
    return p;
  });

  const meanOf = (p, a, b) => (p[b] - p[a]) / Math.max(1, b - a);

  for (let i = 0; i < n; i++) {
    const a0 = Math.max(0, i - w);
    const b1 = Math.min(n, i + w);
    if (i - a0 < w * 0.5 || b1 - i < w * 0.5) continue;

    let d = 0;
    for (let k = 0; k < prefix.length; k++) {
      const before = meanOf(prefix[k], a0, i);
      const after = meanOf(prefix[k], i, b1);
      d += (after - before) * (after - before);
    }
    out[i] = Math.sqrt(d);
  }
  return out;
}

function pickBoundaries(novelty, n, frameRate) {
  const minGap = Math.round(MIN_SECTION_SECONDS * frameRate);
  const threshold = percentile(novelty, 88);

  const peaks = [0];
  // Seeded to 0, not -minGap: frame 0 is already a boundary, so a peak one second in
  // would otherwise be accepted and produce a 1-second "section".
  let last = 0;
  for (let i = 1; i < n - 1; i++) {
    if (novelty[i] < threshold) continue;
    if (i - last < minGap) continue;
    // Local maximum over a generous neighbourhood: section edges are broad, not spiky.
    let isPeak = true;
    const r = Math.round(0.8 * frameRate);
    for (let j = Math.max(0, i - r); j < Math.min(n, i + r); j++) {
      if (novelty[j] > novelty[i]) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    peaks.push(i);
    last = i;
  }

  // The track end is a boundary whether or not anything changed there, so the last
  // section can come out arbitrarily short. Absorb it into the previous one.
  if (peaks.length > 1 && n - peaks[peaks.length - 1] < minGap) peaks.pop();
  peaks.push(n);
  return peaks;
}

function describeSections(boundaries, energy, centroidNorm, n, frameRate) {
  const sections = [];
  const levels = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const startFrame = boundaries[i];
    const endFrame = boundaries[i + 1];
    let e = 0;
    let c = 0;
    for (let f = startFrame; f < endFrame; f++) {
      e += energy[f];
      c += centroidNorm[f];
    }
    const count = Math.max(1, endFrame - startFrame);
    sections.push({
      startFrame,
      endFrame,
      start: startFrame / frameRate,
      end: endFrame / frameRate,
      energy: e / count,
      centroid: c / count
    });
    levels.push(e / count);
  }

  // Classify relative to the track, not an absolute level — a quiet song still has loud
  // parts, and those should read as its drops.
  const sorted = Float32Array.from(levels).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  const lo = q(0.35);
  const hi = q(0.7);
  for (const s of sections) s.kind = s.energy >= hi ? 'high' : s.energy <= lo ? 'quiet' : 'mid';

  return sections;
}

/**
 * How hard the track is currently climbing, 0..1.
 *
 * Rise in energy over the preceding ~3s. Build-ups score high, steady passages near zero.
 */
function tensionCurve(energy, frameRate) {
  const n = energy.length;
  const back = Math.round(3 * frameRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const past = energy[Math.max(0, i - back)];
    out[i] = Math.max(0, energy[i] - past);
  }
  const hi = Math.max(1e-6, percentile(out, 92));
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / hi);
  return out;
}

/**
 * How close the next big lift is, 0..1 — the anticipation signal.
 *
 * For each frame, look ahead up to LOOKAHEAD_SECONDS for a jump from the current running
 * level to a sustained louder one, and weight it by how soon it arrives. The visuals use
 * this to coil before a drop, so the release lands *with* the music rather than a beat
 * after it. This is the payoff for analysing the whole file up front.
 */
function imminenceCurve(energy, energyLong, frameRate) {
  const n = energy.length;
  const ahead = Math.round(LOOKAHEAD_SECONDS * frameRate);
  const step = Math.max(1, Math.round(0.05 * frameRate));
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const here = energyLong[i];
    let best = 0;
    for (let j = i + step; j < Math.min(n, i + ahead); j += step) {
      const jump = energy[j] - here;
      if (jump <= 0) continue;
      // Linear falloff: something 5s away should barely register, 0.5s away should shout.
      const nearness = 1 - (j - i) / ahead;
      const score = jump * nearness * nearness;
      if (score > best) best = score;
    }
    out[i] = best;
  }

  const hi = Math.max(1e-6, percentile(out, 92));
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / hi);
  return smooth(out, Math.round(0.25 * frameRate));
}

/**
 * Fires on the frames just after energy jumps — the moment a drop actually lands.
 * Decays over ~1.5s so the visuals get a discrete event to spend, not a plateau.
 */
function releaseCurve(energy, frameRate) {
  const n = energy.length;
  const back = Math.round(0.35 * frameRate);
  const out = new Float32Array(n);
  const decay = Math.exp(-1 / (1.5 * frameRate));

  let carry = 0;
  for (let i = 0; i < n; i++) {
    const jump = Math.max(0, energy[i] - energy[Math.max(0, i - back)]);
    carry = Math.max(carry * decay, jump);
    out[i] = carry;
  }
  const hi = Math.max(1e-6, percentile(out, 94));
  for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i] / hi);
  return out;
}
