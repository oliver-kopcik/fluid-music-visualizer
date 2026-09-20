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

/**
 * Rates to decode at, in order of preference.
 *
 * decodeAudioData always resamples to its context's rate, and a bare `new AudioContext()`
 * adopts whatever the sound card is running at. On a 96kHz device that silently doubles
 * the decoded size for no audible gain: a 57-minute mix needs 2.65GB and the decode fails
 * with nothing but "Unable to decode audio data" to explain it. The same file decodes in
 * 14 seconds at 48kHz.
 *
 * 48kHz is the first choice because it covers everything audible and is what the export's
 * audio encoder wants anyway. The lower rates are for files long enough to fail even
 * there — an hour of stereo is 1.3GB at 48kHz, and two hours would not fit either.
 */
const DECODE_RATES = [ANALYSIS_SAMPLE_RATE, 24000, 16000];

let sharedContext = null;
let decodeContext = null;

/** One AudioContext for the page; browsers cap how many you may create. */
export function getAudioContext() {
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

/**
 * A context that exists only to set the decode rate.
 *
 * Kept separate from the playback context, which must stay at the device rate. An
 * AudioBuffer is not bound to the context that made it, so one decoded here plays through
 * the other perfectly well — the graph resamples it on the way out.
 */
function contextForRate(rate) {
  if (decodeContext?.sampleRate === rate) return decodeContext;
  decodeContext?.close();
  decodeContext = new AudioContext({ sampleRate: rate });
  return decodeContext;
}

/**
 * @returns {{ buffer: AudioBuffer, mono: Float32Array, name: string }}
 *   `buffer` keeps the original rate and channels for playback and for the export's audio
 *   track; `mono` is the analysis signal.
 */
export async function decodeForAnalysis(file, onNotice = () => {}) {
  const arrayBuffer = await fileToArrayBuffer(file);

  let buffer = null;
  let lastError = null;
  for (const rate of DECODE_RATES) {
    try {
      // decodeAudioData detaches its ArrayBuffer, so each attempt needs its own copy.
      buffer = await contextForRate(rate).decodeAudioData(arrayBuffer.slice(0));
      if (rate !== ANALYSIS_SAMPLE_RATE) {
        onNotice(`Too long to decode at full rate — using ${rate / 1000} kHz`);
      }
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!buffer) {
    // The browser says only "Unable to decode audio data" whether the file is corrupt or
    // merely too large, so say which one this was.
    throw new Error(
      `Could not decode this file. It failed even at ${DECODE_RATES[DECODE_RATES.length - 1] / 1000} kHz, ` +
        `so it is either not audio this browser understands or too long to fit in memory (${lastError?.name ?? 'unknown'}).`
    );
  }

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
  // Already one channel at the rate we want: skip the render and its second full copy,
  // which on a long file is hundreds of megabytes for nothing.
  if (buffer.numberOfChannels === 1 && buffer.sampleRate === ANALYSIS_SAMPLE_RATE) {
    return buffer.getChannelData(0);
  }
  const frames = Math.ceil(buffer.duration * ANALYSIS_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, ANALYSIS_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}
