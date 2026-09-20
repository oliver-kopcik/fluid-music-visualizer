/**
 * Tempo and beat grid from the onset-strength envelope.
 *
 * The grid is optional: it makes the visuals land on bars for four-on-the-floor material,
 * and it is deliberately easy to reject. tempoConfidence below the threshold means the
 * mapping layer falls back to raw onsets — which is the right answer for a rubato vocal,
 * where a confidently wrong beat grid would look far worse than no grid at all.
 */
import { FRAME_RATE } from './spectra.js';

export const MIN_BPM = 60;
export const MAX_BPM = 200;
export const CONFIDENCE_THRESHOLD = 1.6;

function smooth3(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const a = x[Math.max(0, i - 1)];
    const b = x[i];
    const c = x[Math.min(x.length - 1, i + 1)];
    out[i] = 0.25 * a + 0.5 * b + 0.25 * c;
  }
  return out;
}

export function estimateTempo(onsetEnv) {
  const env = smooth3(onsetEnv);
  const n = env.length;
  if (n < FRAME_RATE * 4) {
    return { bpm: 0, confidence: 0, beats: new Float32Array(0), downbeats: new Float32Array(0) };
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const centered = new Float32Array(n);
  for (let i = 0; i < n; i++) centered[i] = env[i] - mean;

  const minLag = Math.floor((60 / MAX_BPM) * FRAME_RATE);
  const maxLag = Math.ceil((60 / MIN_BPM) * FRAME_RATE);

  const scores = new Float32Array(maxLag + 1);
  let best = minLag;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += centered[i] * centered[i + lag];
    acc /= n - lag;

    // Prior centred on 120 BPM. Without it, autocorrelation happily locks onto a half- or
    // double-time lag that fits the data just as well but reads wrong on screen.
    const bpm = (60 * FRAME_RATE) / lag;
    const prior = Math.exp(-0.5 * Math.pow((Math.log2(bpm) - Math.log2(120)) / 0.9, 2));
    const score = acc * prior;

    scores[lag] = score;
    scoreSum += Math.abs(score);
    scoreCount++;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }

  // Octave check: prefer whichever of tau/2, tau, 2*tau lands in a musically plausible range.
  for (const candidate of [Math.round(best / 2), best * 2]) {
    if (candidate < minLag || candidate > maxLag) continue;
    const bpm = (60 * FRAME_RATE) / candidate;
    const currentBpm = (60 * FRAME_RATE) / best;
    const inRange = (b) => b >= 70 && b <= 180;
    if (inRange(bpm) && !inRange(currentBpm) && scores[candidate] > 0.4 * bestScore) {
      best = candidate;
      bestScore = scores[candidate];
    }
  }

  const avgScore = scoreSum / Math.max(1, scoreCount);
  const confidence = avgScore > 0 ? bestScore / avgScore : 0;
  const bpm = (60 * FRAME_RATE) / best;

  const { beats, downbeats } = buildGrid(env, best, n);
  return { bpm, confidence, beats, downbeats, lag: best };
}

/** Phase: slide an impulse train over the envelope and keep the best-fitting offset. */
function buildGrid(env, lag, n) {
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < lag; phase++) {
    let sum = 0;
    for (let i = phase; i < n; i += lag) sum += env[i];
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }

  const beatFrames = [];
  for (let i = bestPhase; i < n; i += lag) beatFrames.push(i);

  // Assume 4/4 and call the strongest of the four positions the downbeat.
  let bestOffset = 0;
  let bestEnergy = -Infinity;
  for (let offset = 0; offset < 4; offset++) {
    let energy = 0;
    let count = 0;
    for (let b = offset; b < beatFrames.length; b += 4) {
      energy += env[beatFrames[b]];
      count++;
    }
    energy /= Math.max(1, count);
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestOffset = offset;
    }
  }

  const beats = Float32Array.from(beatFrames, (f) => f / FRAME_RATE);
  const downbeats = Float32Array.from(
    beatFrames.filter((_, i) => (i - bestOffset) % 4 === 0),
    (f) => f / FRAME_RATE
  );
  return { beats, downbeats };
}
