/**
 * Getting audio into a form we can analyse.
 *
 * Note what is NOT here: an OfflineAudioContext + AnalyserNode. That combination looks
 * like the obvious way to get spectra for a whole file, but AnalyserNode is polled from
 * the wall clock — during offline rendering there is nothing to poll it from, and you get
 * nothing back. OfflineAudioContext is still useful, just as a resampler: it gives us one
 * mono 48 kHz Float32Array, and we run our own FFT over the samples.
 */

export const ANALYSIS_SAMPLE_RATE = 48000;

let sharedContext = null;

/** One AudioContext for the page; browsers cap how many you may create. */
export function getAudioContext() {
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

/**
 * @returns {{ buffer: AudioBuffer, mono: Float32Array, name: string }}
 *   `buffer` keeps the original rate and channels for playback and for the export's audio
 *   track; `mono` is the analysis signal.
 */
export async function decodeForAnalysis(file) {
  const arrayBuffer = await fileToArrayBuffer(file);
  const ctx = getAudioContext();

  // decodeAudioData detaches the ArrayBuffer, so hand it a copy if callers need it later.
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  const mono = await downmixAndResample(buffer);

  return { buffer, mono, name: file.name ?? 'audio' };
}

async function fileToArrayBuffer(file) {
  if (file instanceof ArrayBuffer) return file;
  if (typeof file === 'string') {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`could not fetch ${file}: ${res.status}`);
    return res.arrayBuffer();
  }
  return file.arrayBuffer();
}

async function downmixAndResample(buffer) {
  const frames = Math.ceil(buffer.duration * ANALYSIS_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, ANALYSIS_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}
