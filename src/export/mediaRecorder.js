/**
 * Quick capture: record exactly what is on screen, in realtime, with sound.
 *
 * Honest about what it is. It records the live canvas as it is being composited, so a
 * dropped frame is a dropped frame in the file, permanently, and the output is whatever
 * resolution the window happens to be. That is a fine trade for grabbing a clip; it is
 * not how you produce a final render — see offlineLoop.js for that.
 */
import { downloadBlob } from './fileSink.js';

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
];

function pickMime() {
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
  return '';
}

export function canQuickRecord() {
  return typeof MediaRecorder === 'function' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

/**
 * @param player  the audio player, so the recording carries the track rather than
 *                whatever the microphone hears.
 */
export function startQuickRecord({ canvas, player, fps = 60, videoBitrate = 12_000_000 }) {
  if (!canQuickRecord()) throw new Error('This browser cannot record the canvas.');

  const stream = canvas.captureStream(fps);

  // Tap the audio graph rather than the speakers: no room noise, no level dependency.
  let audioNode = null;
  try {
    const ctx = player.analyser.context;
    audioNode = ctx.createMediaStreamDestination();
    player.connectTo(audioNode);
    for (const track of audioNode.stream.getAudioTracks()) stream.addTrack(track);
  } catch (err) {
    console.warn('recording without audio:', err);
  }

  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: videoBitrate
  });

  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);
  const startedAt = performance.now();

  return {
    mimeType: mimeType || 'video/webm',
    get elapsed() {
      return (performance.now() - startedAt) / 1000;
    },
    async stop(filename) {
      const done = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.stop();
      await done;
      for (const track of stream.getTracks()) track.stop();
      audioNode?.disconnect?.();

      const type = recorder.mimeType || mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? '.mp4' : '.webm';
      downloadBlob(blob, filename.replace(/\.\w+$/, '') + ext);
      return { bytes: blob.size, type };
    }
  };
}
