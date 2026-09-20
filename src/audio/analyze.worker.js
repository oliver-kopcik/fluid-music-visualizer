/**
 * The whole analysis pass, off the main thread.
 *
 * A 3-minute track is ~21,600 FFT frames. That is well under a second of work, but it is
 * a second of *blocking* work, and dropping the first frames of playback to a stall is
 * exactly the kind of thing you notice.
 */
import {
  FRAME_CENTER_OFFSET,
  createSpectrogram,
  bandEnergyDb,
  spectralCentroid,
  normalizeCentroid,
  spectralFlux,
  FFT_SIZE,
  FRAME_RATE,
  BAND_NAMES,
  SPECTRUM_BINS
} from './spectra.js';
import { normalizeRobust, scaleByP95, percentile } from './normalize.js';
import { detectOnsets, mergeOnsets, DEFAULT_PARAMS } from './onsets.js';
import { estimateTempo, CONFIDENCE_THRESHOLD } from './tempo.js';
import { analyzeSections } from './sections.js';
import { spectralFlatness, onsetPitches, rankNormalize } from './timbre.js';


/**
 * Treble level below which we assume there is no drum kit.
 *
 * Hi-hats and cymbals are the loudest thing above 6 kHz in almost any kit, so a track with
 * nothing up there has no percussion to key the visuals off. Measured over the test set:
 * EDM 16.8, a mixed pop track 16.3, a drumless instrumental lead 1.3 — a 15 dB gap.
 *
 * Bass level does NOT work as the discriminator, which is what this originally used: a
 * sustained lead's fundamental sits in the same 30-130 Hz range as a kick, so a drumless
 * track still produces ~2 low-band onsets/sec. Note these are raw FFT magnitude sums, not
 * dBFS, hence the positive values.
 *
 * This is a heuristic on a continuous quantity, so presets can override `profile`.
 */
const SPARSE_TREBLE_DB = 8;

self.onmessage = async (e) => {
  const { samples, sampleRate, name } = e.data;
  try {
    const timeline = analyze(new Float32Array(samples), sampleRate, name, (progress) => {
      self.postMessage({ type: 'progress', progress });
    });
    self.postMessage({ type: 'done', timeline }, transfersOf(timeline));
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};

function transfersOf(timeline) {
  const out = [];
  for (const v of Object.values(timeline)) {
    if (ArrayBuffer.isView(v)) out.push(v.buffer);
  }
  return out;
}

function analyze(samples, sampleRate, name, onProgress) {
  const spec = createSpectrogram(samples, sampleRate);
  const n = spec.numFrames;

  const raw = {};
  for (const band of BAND_NAMES) raw[band] = new Float32Array(n);
  const rms = new Float32Array(n);
  const rmsDb = new Float32Array(n);
  const centroidHz = new Float32Array(n);
  const centroidNorm = new Float32Array(n);
  const flatness = new Float32Array(n);
  const flux = new Float32Array(n);
  const fluxLow = new Float32Array(n);
  const fluxHigh = new Float32Array(n);
  const spectrum32 = new Float32Array(n * SPECTRUM_BINS);

  const half = FFT_SIZE / 2;
  const prevLog = new Float32Array(half + 1);
  const curLog = new Float32Array(half + 1);

  // Kick range, not "everything low". Widening this to 500 Hz pulls in the whole bassline,
  // whose spectrum wobbles continuously, and the flux curve stops having distinct peaks.
  const hzToBin = (hz) => Math.max(1, Math.min(half, Math.round(hz / (sampleRate / FFT_SIZE))));
  const lowRange = [hzToBin(30), hzToBin(130)];
  const highRange = [hzToBin(2000), hzToBin(10000)];
  const fullRange = [1, half];

  let prevCentroid = 400;

  for (let f = 0; f < n; f++) {
    const mag = spec.frameAt(f);

    for (const band of BAND_NAMES) raw[band][f] = bandEnergyDb(mag, spec.bandBins[band]);

    const r = spec.rmsAt(f);
    rms[f] = r;
    rmsDb[f] = 20 * Math.log10(r + 1e-9);

    prevCentroid = spectralCentroid(mag, spec.centroidRange, sampleRate, FFT_SIZE, prevCentroid);
    centroidHz[f] = prevCentroid;
    centroidNorm[f] = normalizeCentroid(prevCentroid);
    flatness[f] = spectralFlatness(mag, 4, half);

    // One pass fills curLog; the band-limited fluxes reuse it rather than re-logging.
    flux[f] = spectralFlux(mag, prevLog, curLog, fullRange);
    fluxLow[f] = partialFlux(curLog, prevLog, lowRange);
    fluxHigh[f] = partialFlux(curLog, prevLog, highRange);
    prevLog.set(curLog);

    const base = f * SPECTRUM_BINS;
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      let sum = 0;
      for (let k = spec.specEdges[b]; k < spec.specEdges[b + 1]; k++) sum += mag[k] * mag[k];
      spectrum32[base + b] = Math.sqrt(sum);
    }

    if ((f & 511) === 0) onProgress(f / n);
  }

  // --- normalize -----------------------------------------------------------------------
  const bands = {};
  for (const band of BAND_NAMES) bands[band] = normalizeRobust(raw[band]).out;
  const rmsNorm = normalizeRobust(rms).out;
  normalizeSpectrum(spectrum32);

  // Flux is scaled, never clamped — see scaleByP95. Detection runs on these, so the peaks
  // must keep their relative heights.
  const fluxNorm = scaleByP95(flux).out;
  const fluxLowNorm = scaleByP95(fluxLow).out;
  const fluxHighNorm = scaleByP95(fluxHigh).out;

  // A single noisy frame shouldn't read as a hit; three-tap smoothing costs nothing and
  // makes the local-maximum test mean something.
  smooth3InPlace(fluxNorm);
  smooth3InPlace(fluxLowNorm);
  smooth3InPlace(fluxHighNorm);

  // --- onsets --------------------------------------------------------------------------
  let meanTrebleDb = 0;
  for (let f = 0; f < n; f++) meanTrebleDb += raw.treble[f];
  meanTrebleDb /= Math.max(1, n);

  // No kit means nothing worth gating hard on. Lower the bar and let the sustain and
  // pitch-steering terms carry the motion instead.
  const profile = meanTrebleDb < SPARSE_TREBLE_DB ? 'sparse' : 'full';
  const params =
    profile === 'sparse'
      ? { ...DEFAULT_PARAMS, delta: 1.25, minStrength: 0.08 }
      : DEFAULT_PARAMS;

  // A kick can't retrigger in 58ms; hats can. Holding the low band to a musical minimum
  // gap is what stops one kick being read as a flam.
  const low = detectOnsets(fluxLowNorm, {
    ...params,
    minGapFrames: 14,
    minStrength: profile === 'sparse' ? params.minStrength : 0.25
  });
  const high = detectOnsets(fluxHighNorm, {
    ...params,
    minStrength: profile === 'sparse' ? params.minStrength : 0.2
  });
  const full = detectOnsets(fluxNorm, { ...params, delta: params.delta * 1.25 });
  const onsets = mergeOnsets(low.onsets, high.onsets, full.onsets);

  /**
   * Re-label each onset by where the energy actually is, not by which flux moved most.
   *
   * Flux measures change, and the two bands have very different baselines. Between kicks
   * the 30-130Hz band is silent, so a snare's small low-frequency content is an enormous
   * *relative* jump, while the 2-10kHz band already has hats ringing and the same snare
   * is a modest addition. Measured on a synthesised backbeat: at every snare, fluxLow was
   * 17.0 against fluxHigh 2.1, and every single snare was drawn as a kick.
   *
   * Band energy does not have that problem — a kick has 30-130Hz energy and a snare does
   * not, whatever either one does to the derivative. The band-limited detectors still
   * decide *when* a hit happened; this decides what it was.
   */
  for (const o of onsets) {
    const f = Math.min(n - 1, Math.max(0, Math.round((o.t - FRAME_CENTER_OFFSET) * FRAME_RATE)));
    const lowEnergy = bands.sub[f] + bands.bass[f];
    const highEnergy = bands.highMid[f] + bands.treble[f];
    if (lowEnergy > highEnergy * 1.15) o.band = 'low';
    else if (highEnergy > lowEnergy * 1.15) o.band = 'high';
  }

  const tempo = estimateTempo(fluxNorm);

  /**
   * Two continuous numbers per onset, which are what the visuals are actually built from:
   * where the sound sits in the spectrum, and how hard it hit. Everything about how a hit
   * is drawn varies smoothly with these, so there is no bucket for a sound to fall into
   * wrongly — the failure that made a kick look like a hi-hat whenever clustering split it.
   */
  const onsetPitch = rankNormalize(
    onsetPitches(onsets, {
      spectrum32,
      spectrumBins: SPECTRUM_BINS,
      rms: rmsNorm,
      frameRate: FRAME_RATE,
      numFrames: n,
      frameCenterOffset: FRAME_CENTER_OFFSET
    })
  );
  const onsetNoise = rankNormalize(
    Float32Array.from(onsets, (o) => {
      const f = Math.min(n - 1, Math.max(0, Math.round((o.t - FRAME_CENTER_OFFSET) * FRAME_RATE)));
      return flatness[f];
    })
  );

  /**
   * Autocorrelation confidence alone is not enough to trust a beat grid.
   *
   * The drumless lead scores 5.71 — well above the threshold — because its phrasing is
   * periodic enough to autocorrelate, and it yields a confident 133 BPM that nothing
   * actually lands on. Phase coherence of the low-band onsets against that period is the
   * check that catches it: EDM 0.24, mixed pop 0.12, drumless lead 0.02.
   *
   * A grid no hit lands on is worse than no grid, because the visuals would pulse against
   * the music instead of with it.
   */
  const kickCoherence = phaseCoherence(low.onsets, tempo.bpm);
  const gridUsable = tempo.confidence >= CONFIDENCE_THRESHOLD && kickCoherence >= 0.12;

  /**
   * A second centroid curve, stretched to this track's own range, for palette lookup.
   *
   * centroidNorm maps 200 Hz-6 kHz absolutely, which is right for comparing tracks but
   * wrong for choosing colour: on the EDM track the middle 50% of frames fall between
   * 0.545 and 0.769, so the palette only ever showed a narrow band of cyan. Equalising
   * against the track's own p10/p90 spreads the same motion across the whole palette.
   *
   * The blend keeps some absolute anchoring, so a genuinely dark track still reads darker
   * than a bright one instead of every track using the identical hue sweep.
   */
  const cLo = percentile(centroidNorm, 10);
  const cHi = percentile(centroidNorm, 90);
  const cSpan = Math.max(0.05, cHi - cLo);
  const centroidPalette = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const stretched = Math.min(1, Math.max(0, (centroidNorm[f] - cLo) / cSpan));
    centroidPalette[f] = 0.75 * stretched + 0.25 * centroidNorm[f];
  }

  // Sustain: energy that is not attack. A held note scores high here and near zero on
  // flux, which is what keeps a drumless lead moving between its attacks.
  const sustain = new Float32Array(n);
  for (let f = 0; f < n; f++) sustain[f] = Math.max(0, Math.min(1, rmsNorm[f] - 0.5 * fluxNorm[f]));

  // Structure: where the sections are, and what is about to happen.
  const structure = analyzeSections(
    {
      rms: rmsNorm,
      bass: bands.bass,
      mid: bands.mid,
      treble: bands.treble,
      centroidNorm,
      sustain,
      flux: fluxNorm,
      onsetTimes: Float32Array.from(onsets, (o) => o.t)
    },
    FRAME_RATE
  );

  return {
    version: 13,
    ...structure,
    name,
    frameRate: FRAME_RATE,
    frameCenterOffset: FRAME_CENTER_OFFSET,
    numFrames: n,
    duration: n / FRAME_RATE,
    profile,
    meanTrebleDb,
    tempoBPM: tempo.bpm,
    tempoConfidence: tempo.confidence,
    gridUsable,
    kickCoherence,
    ...bands,
    bassDb: raw.bass,
    midDb: raw.mid,
    trebleDb: raw.treble,
    rms: rmsNorm,
    rmsDb,
    centroidHz,
    centroidNorm,
    centroidPalette,
    flux: fluxNorm,
    fluxLow: fluxLowNorm,
    fluxHigh: fluxHighNorm,
    thresholdLow: low.threshold,
    thresholdHigh: high.threshold,
    thresholdFull: full.threshold,
    sustain,
    spectrum32,
    beats: tempo.beats,
    downbeats: tempo.downbeats,
    onsetTimes: Float32Array.from(onsets, (o) => o.t),
    onsetStrengths: Float32Array.from(onsets, (o) => o.strength),
    onsetBands: Uint8Array.from(onsets, (o) => (o.band === 'low' ? 0 : o.band === 'high' ? 1 : 2)),
    onsetPitch,
    onsetNoise,
    flatness
  };
}

/** Resultant length of onset phases on the unit circle: 1 = perfectly on the beat. */
function phaseCoherence(onsets, bpm) {
  if (!onsets.length || !bpm) return 0;
  const period = 60 / bpm;
  let re = 0;
  let im = 0;
  for (const o of onsets) {
    const angle = (2 * Math.PI * (o.t % period)) / period;
    re += Math.cos(angle);
    im += Math.sin(angle);
  }
  return Math.sqrt(re * re + im * im) / onsets.length;
}

function smooth3InPlace(x) {
  let prev = x[0];
  for (let i = 1; i < x.length - 1; i++) {
    const cur = x[i];
    x[i] = 0.25 * prev + 0.5 * cur + 0.25 * x[i + 1];
    prev = cur;
  }
}

function partialFlux(curLog, prevLog, [lo, hi]) {
  let sum = 0;
  for (let k = lo; k <= hi; k++) {
    const d = curLog[k] - prevLog[k];
    if (d > 0) sum += d;
  }
  return sum;
}

function normalizeSpectrum(spectrum) {
  let max = 0;
  for (let i = 0; i < spectrum.length; i++) if (spectrum[i] > max) max = spectrum[i];
  const scale = max > 0 ? 1 / max : 0;
  for (let i = 0; i < spectrum.length; i++) spectrum[i] = Math.pow(spectrum[i] * scale, 0.5);
}
