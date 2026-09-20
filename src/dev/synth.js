/**
 * Synthetic test signals with known ground truth.
 *
 * Real tracks can only be checked against judgement — "does that look like the drop?".
 * These are built to order, so the answers are known exactly: a kick lands at precisely
 * 0.5s intervals, the sweep's centroid is a known function of time, the structured loop
 * changes section at exactly 8 and 24 seconds. That turns "the visualizer feels right"
 * into assertions that either hold or don't.
 *
 * Everything is plain Float32Array at the analysis rate, so it feeds analyzeTrack()
 * directly without going near decodeAudioData.
 */
import { ANALYSIS_SAMPLE_RATE } from '../audio/decode.js';

const SR = ANALYSIS_SAMPLE_RATE;

/** Deterministic noise, so a failing test fails the same way twice. */
function noiseGen(seed = 12345) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * Shape a hit's envelope so it is physically plausible at both ends.
 *
 * Both of these were bugs in this fixture that looked like detector bugs:
 *
 * - Ending a still-audible decay produces a broadband click, and a *linear* fade is
 *   barely better: amplitude-modulating a 45Hz sine splatters energy across the low band.
 *   The detector correctly reported an onset at every kick's tail, exactly half a beat
 *   after the kick. A raised cosine is smooth in its first derivative and does not.
 *
 * - Starting a hit instantaneously is a step, and a step is broadband by definition, so
 *   a synthesised snare lit up the 30-130Hz kick detector harder than the 2-10kHz snare
 *   detector. Real drums have a finite attack; without one the test signal simply isn't
 *   a snare.
 */
function shape(buf, { attackMs = 1.5, releaseMs = 45 } = {}) {
  const a = Math.min(buf.length, Math.round((attackMs / 1000) * SR));
  for (let i = 0; i < a; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / a);

  const r = Math.min(buf.length - a, Math.round((releaseMs / 1000) * SR));
  for (let i = 0; i < r; i++) {
    const x = i / r; // 0 at the very end, 1 where the release begins
    buf[buf.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * x);
  }
  return buf;
}

/**
 * Noise with a rising spectrum, via cascaded first differences.
 *
 * The previous attempt used `hp = a * (hp + x - xPrev)`, whose cutoff is roughly
 * fs*(1-a)/2pi — so a LARGER `a` gives a LOWER cutoff. The "hi-hat" at a = 0.96 was
 * filtered at about 306Hz and was not bright at all; in isolation it produced no onsets
 * whatsoever, and the "snare" put more energy in the 30-130Hz kick band than in the
 * 2-10kHz snare band. The detector was reading the fixture correctly; the fixture was
 * wrong.
 *
 * Each difference is an exact +6dB/octave tilt with a zero at DC, so `order` gives a
 * predictable slope with no cutoff frequency to get backwards.
 */
function brightNoise(n, seed, order = 2) {
  const rnd = noiseGen(seed);
  let buf = new Float32Array(n + order);
  for (let i = 0; i < buf.length; i++) buf[i] = rnd();
  for (let o = 0; o < order; o++) {
    const next = new Float32Array(buf.length - 1);
    for (let i = 0; i < next.length; i++) next[i] = buf[i + 1] - buf[i];
    buf = next;
  }
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] /= peak;
  return buf;
}

function addAt(buf, start, samples) {
  const n = Math.min(samples.length, buf.length - start);
  for (let i = 0; i < n; i++) buf[start + i] += samples[i];
}

/** Kick: pitch drops 120Hz to 45Hz in 40ms, amplitude decays over ~360ms. */
export function kick(gain = 1) {
  const dur = Math.round(0.36 * SR);
  const out = new Float32Array(dur);
  let phase = 0;
  for (let i = 0; i < dur; i++) {
    const t = i / SR;
    const f = 45 + 75 * Math.exp(-t / 0.018);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * Math.exp(-t / 0.075) * gain;
  }
  return shape(out, { attackMs: 1, releaseMs: 90 });
}

/** Snare: noise burst plus a 190Hz body. Lots of 2-10kHz content, which is what the
 *  high-band flux detector keys on. */
export function snare(gain = 1, seed = 7) {
  const dur = Math.round(0.18 * SR);
  const out = new Float32Array(dur);
  const noise = brightNoise(dur, seed, 2);
  let phase = 0;
  for (let i = 0; i < dur; i++) {
    const t = i / SR;
    phase += (2 * Math.PI * 190) / SR;
    // Body kept well below the noise: a snare is mostly the rattle, and a loud 190Hz
    // tone would put the hit back into the low bands.
    out[i] = (noise[i] * 0.95 + Math.sin(phase) * 0.18) * Math.exp(-t / 0.045) * gain;
  }
  return shape(out, { attackMs: 1.5, releaseMs: 40 });
}

/** Hi-hat: short, bright, almost all above 6kHz. */
export function hat(gain = 0.35, seed = 11) {
  const dur = Math.round(0.05 * SR);
  const out = new Float32Array(dur);
  const noise = brightNoise(dur, seed, 3);
  for (let i = 0; i < dur; i++) {
    out[i] = noise[i] * Math.exp(-(i / SR) / 0.012) * gain;
  }
  return shape(out, { attackMs: 0.8, releaseMs: 14 });
}

/**
 * Open hi-hat: the same noise source as `hat`, ringing for 300ms instead of 12.
 *
 * Deliberately built from the identical generator so the pair differs in envelope and in
 * nothing else. Pitch, noisiness and level cannot tell them apart, which is exactly the
 * case the envelope axis exists to cover.
 */
export function openHat(gain = 0.3, seed = 17) {
  const dur = Math.round(0.4 * SR);
  const out = new Float32Array(dur);
  const noise = brightNoise(dur, seed, 3);
  for (let i = 0; i < dur; i++) {
    out[i] = noise[i] * Math.exp(-(i / SR) / 0.11) * gain;
  }
  return shape(out, { attackMs: 0.8, releaseMs: 60 });
}

/**
 * Kick on the beat, closed hat a quarter-beat later, open hat on the half.
 *
 * The kick is there so the track spans a real pitch range. Neither hat is allowed to land
 * on it: the first version struck the closed hat together with the kick, and the kick's
 * low end dragged that hat's measured pitch down so far that the pair separated on pitch
 * — which would have let the test pass while proving nothing about envelope.
 */
export function hatPair({ bpm = 120, bars = 8 } = {}) {
  const beat = 60 / bpm;
  const beats = bars * 4;
  const buf = new Float32Array(Math.round((beats * beat + 0.8) * SR));
  const closed = [];
  const open = [];
  const kicks = [];
  for (let b = 0; b < beats; b++) {
    const at = Math.round(b * beat * SR);
    addAt(buf, at, kick());
    kicks.push(b * beat);
    addAt(buf, at + Math.round(beat * 0.25 * SR), hat(0.3, 11 + b));
    closed.push((b + 0.25) * beat);
    addAt(buf, at + Math.round(beat * 0.5 * SR), openHat(0.3, 17 + b));
    open.push((b + 0.5) * beat);
  }
  return { mono: buf, bpm, closed, open, kicks, beat };
}

/** Sustained chord. No transients at all — this is what `sparse` should detect. */
export function pad(seconds, gain = 0.25, root = 220) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const partials = [1, 1.26, 1.5, 2];
  for (const mult of partials) {
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase += (2 * Math.PI * root * mult) / SR;
      // Slow tremolo, so it is not perfectly static.
      const lfo = 1 + 0.15 * Math.sin((2 * Math.PI * 0.2 * i) / SR);
      out[i] += (Math.sin(phase) * gain * lfo) / partials.length;
    }
  }
  // Fade the ends so the buffer edges are not themselves transients.
  const fade = Math.round(0.25 * SR);
  for (let i = 0; i < fade && i < n; i++) {
    out[i] *= i / fade;
    out[n - 1 - i] *= i / fade;
  }
  return out;
}

/** Exponential frequency sweep — the centroid should follow it. */
export function sineSweep(seconds, f0 = 200, f1 = 5000, gain = 0.5) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = f0 * Math.pow(f1 / f0, t);
    phase += (2 * Math.PI * f) / SR;
    out[i] = Math.sin(phase) * gain;
  }
  return out;
}

export function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

/**
 * Four on the floor. Kick on every beat and nothing else, so onset times are known
 * exactly: beat k lands at k * 60/bpm.
 */
export function fourOnFloor({ bpm = 120, bars = 8, withHats = false } = {}) {
  const beat = 60 / bpm;
  const beats = bars * 4;
  const buf = new Float32Array(Math.round((beats * beat + 0.5) * SR));
  const expectedOnsets = [];
  for (let b = 0; b < beats; b++) {
    const at = Math.round(b * beat * SR);
    addAt(buf, at, kick());
    expectedOnsets.push(b * beat);
    if (withHats) {
      addAt(buf, at + Math.round(beat * 0.5 * SR), hat(0.3, 11 + b));
    }
  }
  return { mono: buf, bpm, expectedOnsets, beat };
}

/** Kick on 1 and 3, snare on 2 and 4, hats on every eighth. */
export function backbeat({ bpm = 128, bars = 8 } = {}) {
  const beat = 60 / bpm;
  const beats = bars * 4;
  const buf = new Float32Array(Math.round((beats * beat + 0.5) * SR));
  const kicks = [];
  const snares = [];
  for (let b = 0; b < beats; b++) {
    const at = Math.round(b * beat * SR);
    if (b % 4 === 0 || b % 4 === 2) {
      addAt(buf, at, kick());
      kicks.push(b * beat);
    }
    if (b % 4 === 1 || b % 4 === 3) {
      addAt(buf, at, snare(0.9, 7 + b));
      snares.push(b * beat);
    }
    addAt(buf, at, hat(0.25, 31 + b));
    addAt(buf, at + Math.round(beat * 0.5 * SR), hat(0.2, 61 + b));
  }
  return { mono: buf, bpm, kicks, snares, beat };
}

/**
 * A miniature arrangement with known structure:
 *
 *   0-8s    pad only, quiet            -> should read sparse/quiet
 *   8-16s   build: hats accelerating, rising pad -> imminence should climb
 *   16-32s  full drop: kick + snare + hats, loud -> release fires at 16
 *   32-40s  breakdown: pad only        -> quiet again
 *   40-56s  second drop                -> release fires at 40
 *
 * Boundaries are exact, so section detection can be scored rather than eyeballed.
 */
export function structured({ bpm = 128 } = {}) {
  const beat = 60 / bpm;
  const total = 56;
  const buf = new Float32Array(Math.round(total * SR));
  const expectedBoundaries = [8, 16, 32, 40];
  const expectedDrops = [16, 40];

  addAt(buf, 0, pad(16, 0.2, 220));
  addAt(buf, Math.round(32 * SR), pad(8, 0.18, 196));

  // Build: hats getting denser and louder as 16s approaches.
  for (let t = 8; t < 16; ) {
    const progress = (t - 8) / 8;
    const step = beat * (0.5 - 0.3 * progress);
    addAt(buf, Math.round(t * SR), hat(0.15 + 0.5 * progress, Math.round(t * 1000)));
    t += step;
  }

  const drum = (from, to, gain) => {
    for (let b = 0; ; b++) {
      const t = from + b * beat;
      if (t >= to) break;
      const at = Math.round(t * SR);
      if (b % 2 === 0) addAt(buf, at, kick(gain));
      else addAt(buf, at, snare(gain * 0.85, 100 + b));
      addAt(buf, at, hat(0.3 * gain, 200 + b));
      addAt(buf, at + Math.round(beat * 0.5 * SR), hat(0.22 * gain, 300 + b));
    }
    // A sustained bass under the drums, so the section has weight as well as hits.
    let phase = 0;
    for (let i = Math.round(from * SR); i < Math.round(to * SR) && i < buf.length; i++) {
      phase += (2 * Math.PI * 55) / SR;
      buf[i] += Math.sin(phase) * 0.18 * gain;
    }
  };

  drum(16, 32, 1);
  drum(40, 56, 1);

  return { mono: buf, bpm, expectedBoundaries, expectedDrops, duration: total };
}

export const SYNTH_RATE = SR;
