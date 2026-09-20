/**
 * Telling sounds apart.
 *
 * Band-limited flux answers "was this low or high", which is enough to separate a kick
 * from a snare and nothing else. Every other sound in a track — a hat, a clap, a synth
 * stab, a plucked note, a vocal consonant — landed in the same two buckets and was drawn
 * identically. That is why a busy section reads as undifferentiated activity: the visuals
 * genuinely did not know one sound from another.
 *
 * So each onset gets two continuous descriptions instead: where in the spectrum it
 * arrived, and how noisy it is. Both are rank-normalised within the track, because what
 * matters is which of this track's sounds is the lowest, not how it compares to a fixed
 * number — the same mistake, made against an absolute threshold, is why a test for "noisy"
 * fired on a synthesised drum kit and never once on real music.
 *
 * An earlier version clustered the fingerprints and gave each cluster its own look. It is
 * gone because it was only as good as its worst boundary: when the kick split across two
 * clusters, one of them was drawn with a gesture meant for something else and half the
 * beats stopped reading as beats. Continuous descriptions degrade gently instead.
 */

/**
 * Spectral flatness: geometric mean over arithmetic mean.
 *
 * Near 1 for noise, near 0 for a tone. This is the measure that separates a snare from a
 * bass stab when both are loud and broadband-ish — the snare is noise, the stab is not.
 */
export function spectralFlatness(mag, lo, hi) {
  let logSum = 0;
  let sum = 0;
  let n = 0;
  for (let k = lo; k <= hi; k++) {
    const v = mag[k] + 1e-9;
    logSum += Math.log(v);
    sum += v;
    n++;
  }
  if (n === 0 || sum <= 0) return 0;
  return Math.exp(logSum / n) / (sum / n);
}

/**
 * Where each onset's *arrival* sits in the spectrum, 0 (low) to 1 (high).
 *
 * Deliberately measured on the rise — the increase in each band over the two frames before
 * the onset — rather than on the spectrum at the onset frame. In a dense mix the spectrum
 * during a kick also contains every synth playing over it, which is why clustering on
 * spectral shape kept deciding the kick was a mid-height sound. What *changed* at that
 * instant is the sound that just started, and for a kick that is unambiguously the bottom
 * of the range whatever else is going on.
 *
 * Bin index is used directly as the position because the 32 bins are log-spaced from 40 Hz
 * to 16 kHz, so evenly spaced indices are evenly spaced octaves — which is how pitch is
 * heard and therefore how it should map to a picture.
 *
 * The stored spectrum is square-rooted for display, so it is raised to the fourth here to
 * get back to energy before the bands are compared. That compression is not cosmetic at
 * this stage: it lifts a hi-hat sitting at 1% of a kick's magnitude to 10% of it, enough
 * high-frequency weight to drag a kick that lands together with a crash up to the top of
 * the range. Measured on energy, low-band onsets average 0.29 against 0.50 for high-band
 * ones; measured on the compressed values the two are half as far apart.
 */
const ENERGY = 4;
export function onsetPitches(onsets, { spectrum32, spectrumBins, rms, frameRate, numFrames, frameCenterOffset }) {
  const out = new Float32Array(onsets.length);
  for (let i = 0; i < onsets.length; i++) {
    const t = onsets[i].t - frameCenterOffset;
    const f = Math.min(numFrames - 1, Math.max(0, Math.round(t * frameRate)));
    const prev = Math.max(0, f - 2);
    let weighted = 0;
    let total = 0;
    for (let b = 0; b < spectrumBins; b++) {
      const rise =
        Math.pow(spectrum32[f * spectrumBins + b], ENERGY) - Math.pow(spectrum32[prev * spectrumBins + b], ENERGY);
      if (rise <= 0) continue;
      weighted += (b / (spectrumBins - 1)) * rise;
      total += rise;
    }
    // Nothing rose — the detector fired on a decay or a level change. Fall back to where
    // the energy is, which is the best available answer rather than an arbitrary one.
    if (total <= 0) {
      for (let b = 0; b < spectrumBins; b++) {
        const v = Math.pow(spectrum32[f * spectrumBins + b], ENERGY);
        weighted += (b / (spectrumBins - 1)) * v;
        total += v;
      }
    }
    out[i] = total > 0 ? weighted / total : 0.5;
  }
  return out;
}

/**
 * Stretch values onto 0..1 by rank.
 *
 * Raw flux-weighted position lands in roughly 0.25-0.6 on real music, because no real
 * sound is pure sub-bass or pure air. Using it directly would confine every hit to the
 * middle third of the frame — the same mistake as scoring spectral flatness against an
 * absolute threshold. Rank uses the whole frame whatever range the track happens to
 * occupy, and ties are averaged so a repeated sound keeps a single position.
 */
export function rankNormalize(values) {
  const n = values.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = 0.5;
    return out;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const rank = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[order[k]] = rank;
    i = j + 1;
  }
  return out;
}
