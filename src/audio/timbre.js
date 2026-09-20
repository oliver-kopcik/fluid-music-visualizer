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
 * How long each onset rings, in seconds scaled onto 0..1 over a 600ms cap.
 *
 * "Rings" means falling 20dB from its peak, not the third (-9.5dB) the first version used.
 * A third is over too quickly to be what anyone means by a sound ringing: it put a closed
 * hi-hat at 0.03 and an open one at 0.11, squeezing the entire interesting range into the
 * bottom fifth of the scale. At -20dB the same pair measures 0.06 and 0.43.
 *
 * Crucially it is the sound's *own* contribution that has to fall, measured above whatever
 * was already sounding in that band before it arrived. On a clean fixture the two are the
 * same thing; on real music they are not, and measuring absolute level had 96% of onsets
 * still ringing at the 600ms cap — not because anything rang, but because a mix never
 * falls 20dB below a hit while the rest of the arrangement keeps playing underneath it.
 *
 * This is the axis pitch, loudness and noisiness cannot see: a closed hi-hat and an open
 * one are the same noise at the same brightness and the same level, and differ in nothing
 * but this. Without it they are drawn identically, which is wrong in a way no amount of
 * tuning the other three could fix.
 *
 * Unlike pitch this is NOT ranked within the track. "Rings for 300ms" is a physical fact
 * about the sound, not a comparison: a track made entirely of short hits should have
 * nothing ringing in it, and ranking would hand the longest half of them a tail anyway.
 *
 * Measured on a band around the onset's own pitch rather than on broadband level. On the
 * EDM track 31% of onsets never saw broadband level fall to a third inside the cap — not
 * because they rang, but because the rest of the mix carried on underneath them, which
 * would have made every kick in a busy drop read as ringing for the full 600ms.
 *
 * The peak is taken over a few frames after the onset rather than at the onset frame,
 * because a real attack takes longer than one 8ms hop to reach full level — anchoring on
 * the onset frame measures the rise as though it were the decay.
 */
const DECAY_BAND_HALFWIDTH = 3;

export function onsetDecays(
  onsets,
  { spectrum32, spectrumBins, positions, frameRate, numFrames, frameCenterOffset, maxSeconds = 0.6 }
) {
  const out = new Float32Array(onsets.length);
  const limit = Math.round(maxSeconds * frameRate);
  const peakWindow = Math.max(1, Math.round(0.03 * frameRate));

  for (let i = 0; i < onsets.length; i++) {
    const t = onsets[i].t - frameCenterOffset;
    const f = Math.min(numFrames - 1, Math.max(0, Math.round(t * frameRate)));

    const centre = Math.round((positions?.[i] ?? 0.5) * (spectrumBins - 1));
    const lo = Math.max(0, centre - DECAY_BAND_HALFWIDTH);
    const hi = Math.min(spectrumBins - 1, centre + DECAY_BAND_HALFWIDTH);
    const level = (g) => {
      let sum = 0;
      for (let b = lo; b <= hi; b++) sum += Math.pow(spectrum32[g * spectrumBins + b], 4);
      return sum;
    };

    // What was already sounding in this band, taken as the quietest of the few frames
    // before the attack so the onset's own rise cannot inflate it.
    let baseline = Infinity;
    for (let g = Math.max(0, f - 5); g <= Math.max(0, f - 2); g++) baseline = Math.min(baseline, level(g));
    if (!Number.isFinite(baseline)) baseline = 0;

    // Levels here are energy, so -20dB in amplitude is a factor of 100.
    let peak = 0;
    let peakAt = f;
    for (let g = f; g <= Math.min(numFrames - 1, f + peakWindow); g++) {
      const v = level(g) - baseline;
      if (v > peak) {
        peak = v;
        peakAt = g;
      }
    }
    if (peak <= 0) {
      out[i] = 0;
      continue;
    }

    let held = limit;
    for (let g = peakAt; g <= Math.min(numFrames - 1, peakAt + limit); g++) {
      if (level(g) - baseline < peak / 100) {
        held = g - peakAt;
        break;
      }
    }
    out[i] = held / limit;
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
