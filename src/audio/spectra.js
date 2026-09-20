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

  return { numFrames, frameAt, rmsAt, mag, bandBins, specEdges, centroidRange, sampleRate };
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
