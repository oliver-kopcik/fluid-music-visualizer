/**
 * Short-time spectra, and the per-frame features we pull out of them.
 *
 * Hop is 400 samples at 48 kHz, i.e. exactly 120 analysis frames per second. That is an
 * integer multiple of 60, 30 and 24 fps, so no frame rate we render at lands awkwardly
 * between analysis frames.
 */
import FFT from 'fft.js';

export const FFT_SIZE = 2048; // 42.7 ms window, 23.44 Hz per bin
export const HOP = 400; // 48000 / 400 = 120 frames per second
export const FRAME_RATE = 120;

/**
 * Seconds between an analysis frame's label and the audio it actually describes.
 *
 * Frame f covers samples [f*HOP, f*HOP + FFT_SIZE), so its centre of mass is half a
 * window later than f/FRAME_RATE. Ignoring this reports every onset early — measured
 * against synthesised kicks at known times, by about 33ms, which is a sixth of a beat at
 * 120 BPM.
 */
export const FRAME_CENTER_OFFSET = FFT_SIZE / 2 / 48000;

/** Band edges in Hz. Split finely enough that a kick and a hi-hat never share a band. */
export const BANDS = {
  sub: [20, 60],
  bass: [60, 160],
  lowMid: [160, 500],
  mid: [500, 2000],
  highMid: [2000, 6000],
  treble: [6000, 16000]
};

export const BAND_NAMES = Object.keys(BANDS);

/** 32 log-spaced bands, for the visual "spectrum" without literally drawing bars. */
export const SPECTRUM_BINS = 32;

/**
 * A second, much finer analysis of the bottom of the range.
 *
 * At 48kHz a 2048-point window resolves 23.4Hz, but the log-spaced display bins are only
 * 8Hz wide down at 40Hz. Several of them therefore rounded onto the same FFT bin and three
 * — 40-48Hz, 48-58Hz and 85-102Hz — came out spanning *zero* bins and read exactly 0.000
 * in every frame of every track. The kick fundamental was being drawn from nothing.
 *
 * Resolving semitones near 50Hz needs a window of a few hundred milliseconds, which is
 * not a compromise but physics: a 50Hz tone takes three cycles even to exist. What punches
 * in a kick is its click, which lives high up where the short window still sees it.
 *
 * Decimating by 16 first makes that window cheap. 512 points at 3kHz spans the same 170ms
 * as 8192 points at 48kHz and resolves the same 5.9Hz, for a twentieth of the work.
 */
const DECIMATION = 16;
const LOW_FFT_SIZE = 512;
/** Bins up to here come from the fine analysis; above it the short window is better. */
const LOW_SPLIT_HZ = 320;

/**
 * Half-band-ish FIR, applied only at output positions (polyphase), so the cost is one
 * multiply-add per input sample per 16th of the taps. Without it everything above 1.5kHz
 * would fold down into exactly the bins this exists to clean up.
 */
function decimate(samples, factor) {
  const taps = 97;
  const cutoff = 0.85 / factor; // cycles/sample, safely under the new Nyquist
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)); // Hamming
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;

  const out = new Float32Array(Math.ceil(samples.length / factor));
  for (let o = 0; o < out.length; o++) {
    const centre = o * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = centre + i - mid;
      if (j >= 0 && j < samples.length) acc += samples[j] * h[i];
    }
    out[o] = acc;
  }
  return out;
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

function binRange(loHz, hiHz, sampleRate, fftSize) {
  const perBin = sampleRate / fftSize;
  return [Math.max(1, Math.floor(loHz / perBin)), Math.min(fftSize / 2, Math.ceil(hiHz / perBin))];
}

/**
 * Streams magnitude spectra frame by frame. Deliberately allocation-free after setup —
 * a 3-minute track is ~21,600 frames, and per-frame garbage there is what turns a
 * half-second analysis into a multi-second one.
 */
export function createSpectrogram(samples, sampleRate = 48000) {
  const fft = new FFT(FFT_SIZE);
  const window = hannWindow(FFT_SIZE);
  const input = new Float32Array(FFT_SIZE);
  const output = fft.createComplexArray();
  const mag = new Float32Array(FFT_SIZE / 2 + 1);

  const numFrames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);

  const bandBins = {};
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    bandBins[name] = binRange(lo, hi, sampleRate, FFT_SIZE);
  }

  // Log-spaced edges from 40 Hz to 16 kHz for the 32-band display spectrum.
  const specEdges = new Int32Array(SPECTRUM_BINS + 1);
  for (let i = 0; i <= SPECTRUM_BINS; i++) {
    const hz = 40 * Math.pow(16000 / 40, i / SPECTRUM_BINS);
    specEdges[i] = Math.min(FFT_SIZE / 2, Math.max(1, Math.round(hz / (sampleRate / FFT_SIZE))));
  }

  // --- the fine low end ---------------------------------------------------------------
  const lowSamples = decimate(samples, DECIMATION);
  const lowRate = sampleRate / DECIMATION;
  const lowFft = new FFT(LOW_FFT_SIZE);
  const lowWindow = hannWindow(LOW_FFT_SIZE);
  const lowInput = new Float32Array(LOW_FFT_SIZE);
  const lowOutput = lowFft.createComplexArray();
  const lowMag = new Float32Array(LOW_FFT_SIZE / 2 + 1);

  /**
   * Which analysis each display bin reads, and over which of its bins.
   *
   * `hi` is forced above `lo` so a bin can never span nothing — that alone is what had
   * three of them reading a constant zero.
   */
  const binSource = [];
  for (let b = 0; b < SPECTRUM_BINS; b++) {
    const hz0 = 40 * Math.pow(16000 / 40, b / SPECTRUM_BINS);
    const hz1 = 40 * Math.pow(16000 / 40, (b + 1) / SPECTRUM_BINS);
    const fine = hz1 <= LOW_SPLIT_HZ;
    const per = fine ? lowRate / LOW_FFT_SIZE : sampleRate / FFT_SIZE;
    const limit = fine ? LOW_FFT_SIZE / 2 : FFT_SIZE / 2;
    const lo = Math.min(limit - 1, Math.max(1, Math.floor(hz0 / per)));
    const hi = Math.min(limit, Math.max(lo + 1, Math.ceil(hz1 / per)));
    binSource.push({ fine, lo, hi });
  }

  /**
   * Both windows are centred on the same sample, so one FRAME_CENTER_OFFSET still
   * describes every frame however long the window behind it was.
   */
  function lowFrameAt(f) {
    const centre = (f * HOP + FFT_SIZE / 2) / DECIMATION;
    const start = Math.round(centre - LOW_FFT_SIZE / 2);
    for (let i = 0; i < LOW_FFT_SIZE; i++) {
      const j = start + i;
      lowInput[i] = (j >= 0 && j < lowSamples.length ? lowSamples[j] : 0) * lowWindow[i];
    }
    lowFft.realTransform(lowOutput, lowInput);
    lowFft.completeSpectrum(lowOutput);
    for (let k = 0; k <= LOW_FFT_SIZE / 2; k++) {
      const re = lowOutput[2 * k];
      const im = lowOutput[2 * k + 1];
      // Scaled back up: decimation divides the transform's magnitude by the same factor,
      // and the two halves of the spectrum have to meet at the split without a step.
      lowMag[k] = Math.sqrt(re * re + im * im) * DECIMATION;
    }
    return lowMag;
  }

  /** Fill the 32 display bins, each from whichever analysis can actually resolve it. */
  function spectrumInto(f, out) {
    const coarse = mag;
    const fine = lowFrameAt(f);
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const { fine: useFine, lo, hi } = binSource[b];
      const src = useFine ? fine : coarse;
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += src[k] * src[k];
      out[b] = Math.sqrt(sum);
    }
    return out;
  }

  const centroidRange = binRange(50, 12000, sampleRate, FFT_SIZE);

  function frameAt(f) {
    const start = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) input[i] = samples[start + i] * window[i];

    fft.realTransform(output, input);
    fft.completeSpectrum(output);

    for (let k = 0; k <= FFT_SIZE / 2; k++) {
      const re = output[2 * k];
      const im = output[2 * k + 1];
      mag[k] = Math.sqrt(re * re + im * im);
    }
    return mag;
  }

  function rmsAt(f) {
    const start = f * HOP;
    let sum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[start + i];
      sum += s * s;
    }
    return Math.sqrt(sum / FFT_SIZE);
  }

  return { numFrames, frameAt, rmsAt, spectrumInto, mag, output, bandBins, specEdges, centroidRange, sampleRate };
}

/** Energy in a bin range, as dB. Summing magnitude squared, not magnitude. */
export function bandEnergyDb(mag, [lo, hi]) {
  let sum = 0;
  for (let k = lo; k <= hi; k++) sum += mag[k] * mag[k];
  return 10 * Math.log10(sum + 1e-12);
}

/**
 * Spectral centroid in Hz — the "brightness" of the frame, which we map to hue.
 *
 * Below an energy floor this holds the previous value instead of computing one. In near
 * silence the numerator and denominator are both noise, and the centroid jumps around
 * wildly; letting that through makes the colour strobe during quiet passages.
 */
export function spectralCentroid(mag, [lo, hi], sampleRate, fftSize, previous) {
  let num = 0;
  let den = 0;
  for (let k = lo; k <= hi; k++) {
    num += ((k * sampleRate) / fftSize) * mag[k];
    den += mag[k];
  }
  if (den < 1e-6) return previous;
  return num / den;
}

/**
 * Hue should track pitch logarithmically — an octave up is a constant hue step, not a
 * constant fraction of 6 kHz.
 */
export function normalizeCentroid(hz) {
  const lo = Math.log2(200);
  const hi = Math.log2(6000);
  const v = (Math.log2(Math.max(50, hz)) - lo) / (hi - lo);
  return Math.min(1, Math.max(0, v));
}

/**
 * Log-compressed, half-wave-rectified spectral flux.
 *
 * The log compression is what makes this work on quiet material: a raw magnitude
 * difference is dominated by whatever is loudest, so a soft attack under a sustained pad
 * barely registers, while log(1 + 100x) gives the quiet attack comparable weight.
 */
export function spectralFlux(mag, prevLog, logBuf, [lo, hi]) {
  let flux = 0;
  for (let k = lo; k <= hi; k++) {
    const v = Math.log(1 + 100 * mag[k]);
    logBuf[k] = v;
    const d = v - prevLog[k];
    if (d > 0) flux += d;
  }
  return flux;
}

/**
 * Chroma: how much of each of the twelve pitch classes is sounding.
 *
 * Folding the spectrum by octave is what separates *harmony* from *brightness*. The
 * centroid can only say a frame got brighter; chroma says the chord changed, which is the
 * thing a listener actually hears happen.
 *
 * Restricted to 55 Hz - 2 kHz because above that the harmonics of everything overlap into
 * mush, and below it the analysis cannot resolve a semitone anyway. Energy is spread
 * between the two nearest classes rather than rounded into one, so a note drifting sharp
 * moves smoothly instead of jumping a class.
 */
export const CHROMA_LO_HZ = 55;
export const CHROMA_HI_HZ = 2000;

export function accumulateChroma(mag, sampleRate, fftSize, out12) {
  out12.fill(0);
  const per = sampleRate / fftSize;
  const lo = Math.max(1, Math.floor(CHROMA_LO_HZ / per));
  const hi = Math.min(fftSize / 2, Math.ceil(CHROMA_HI_HZ / per));
  let total = 0;
  for (let k = lo; k <= hi; k++) {
    const energy = mag[k] * mag[k];
    if (energy <= 0) continue;
    const semitone = 12 * Math.log2((k * per) / 440);
    const pc = ((semitone % 12) + 12) % 12;
    const low = Math.floor(pc);
    const frac = pc - low;
    out12[low % 12] += energy * (1 - frac);
    out12[(low + 1) % 12] += energy * frac;
    total += energy;
  }
  return total;
}

/**
 * Reduce the twelve weights to one direction on the colour wheel.
 *
 * Classes are placed around the circle by fifths, not chromatically, so that keys a fifth
 * apart sit next to each other and a tritone lands opposite. A I-V change is then a small
 * hue step and a distant modulation is a large one, which matches how related the chords
 * sound.
 *
 * Returned as a vector rather than an angle on purpose: the caller has to smooth this over
 * time, and averaging angles across the 1-to-0 wrap gives the opposite colour. Its length
 * doubles as confidence — a clear triad gives a long vector, noise a short one.
 */
export function chromaVector(chroma12, total, out) {
  out.x = 0;
  out.y = 0;
  if (total <= 0) return out;
  for (let pc = 0; pc < 12; pc++) {
    const weight = chroma12[pc] / total;
    const angle = (2 * Math.PI * ((pc * 7) % 12)) / 12;
    out.x += weight * Math.cos(angle);
    out.y += weight * Math.sin(angle);
  }
  return out;
}

/** Side analysis: quarter rate, quarter window, identical bin spacing. See PAN_SAMPLE_RATE. */
export const SIDE_FFT_SIZE = FFT_SIZE / 4;
const SIDE_DECIMATION = 4;
/** Above this a stereo image is barely localisable, and the side channel is filtered out. */
const PAN_MAX_BIN = SIDE_FFT_SIZE / 2;

/**
 * Where each frequency sits between the speakers, -1 left to +1 right.
 *
 * From the mid and side spectra rather than from left and right separately, because that
 * is what the decode already produced and the identity is exact:
 *
 *   L = M + S,  R = M - S
 *   |R|^2 - |L|^2 = -4 Re(M S*)
 *
 * so the balance is -2 Re(M S*) / (|M|^2 + |S|^2). It needs the complex spectra, not
 * magnitudes: two sounds equally loud on both sides differ only in the *sign* of their
 * side component, which magnitude throws away.
 *
 * Per display bin rather than per FFT bin, because that is the resolution everything
 * downstream reads, and it makes the stored curve 32 numbers a frame instead of 1025.
 */
export function createPanAnalysis(side, specEdges) {
  if (!side) return null;
  const fft = new FFT(SIDE_FFT_SIZE);
  const window = hannWindow(SIDE_FFT_SIZE);
  const input = new Float32Array(SIDE_FFT_SIZE);
  const output = fft.createComplexArray();

  function panInto(f, midComplex, out) {
    const centre = (f * HOP + FFT_SIZE / 2) / SIDE_DECIMATION;
    const start = Math.round(centre - SIDE_FFT_SIZE / 2);
    for (let i = 0; i < SIDE_FFT_SIZE; i++) {
      const j = start + i;
      input[i] = (j >= 0 && j < side.length ? side[j] : 0) * window[i];
    }
    fft.realTransform(output, input);
    fft.completeSpectrum(output);

    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const lo = specEdges[b];
      const hi = Math.max(lo + 1, specEdges[b + 1]);
      let num = 0;
      let den = 0;
      for (let k = lo; k < hi && k < PAN_MAX_BIN; k++) {
        const mre = midComplex[2 * k];
        const mim = midComplex[2 * k + 1];
        const sre = output[2 * k];
        const sim = output[2 * k + 1];
        num += mre * sre + mim * sim;
        den += mre * mre + mim * mim + (sre * sre + sim * sim);
      }
      out[b] = den > 1e-12 ? Math.max(-1, Math.min(1, (-2 * num) / den)) : 0;
    }
    return out;
  }

  return { panInto };
}
