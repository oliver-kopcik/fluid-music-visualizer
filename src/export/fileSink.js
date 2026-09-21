/**
 * Where a render's bytes go.
 *
 * Streaming to disk is strongly preferred. A 3-minute 1080p60 render at 20 Mbps is around
 * 450 MB, and holding that in an ArrayBuffer works right up until it doesn't — on a long
 * track or a 1440p render it is a tab crash with the whole render lost. The File System
 * Access API lets the muxer write as it goes, so memory stays flat regardless of length.
 *
 * Not every browser has it, so the in-memory path stays as a fallback with an explicit
 * size warning rather than a silent risk.
 */
import { ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer';

export const canStreamToDisk = () => typeof window.showSaveFilePicker === 'function';

/** Rough output size, for warning before a render that cannot stream. */
/**
 * Roughly what a quality target costs per second, measured on this material at 1080p60.
 *
 * Constant quality means the size is not known in advance, but this only feeds the warning
 * shown before a render that cannot stream to disk, so an approximation from real numbers
 * beats a bitrate that no longer describes anything. Measured busy-to-quiet spans at each
 * point; the higher figure is used so the warning errs toward caution.
 */
const QUALITY_BITRATE = [
  [6, 45_000_000],
  [10, 30_000_000],
  [14, 18_000_000],
  [18, 10_000_000]
];

export function bitrateForQuality(quantizer) {
  const points = QUALITY_BITRATE;
  if (quantizer <= points[0][0]) return points[0][1];
  if (quantizer >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 1; i < points.length; i++) {
    const [q0, b0] = points[i - 1];
    const [q1, b1] = points[i];
    if (quantizer <= q1) return b0 + ((b1 - b0) * (quantizer - q0)) / (q1 - q0);
  }
  return points[points.length - 1][1];
}

export function estimateBytes({ seconds, videoBitrate, quantizer = null, audioBitrate = 192000 }) {
  const video = quantizer != null ? bitrateForQuality(quantizer) : videoBitrate;
  return ((video + audioBitrate) / 8) * seconds;
}

/**
 * @returns {{ target, finish: () => Promise<Blob|null>, cancel: () => Promise<void>, streaming: boolean }}
 */
export async function createSink({ filename, mimeType = 'video/mp4', TargetImpl = null, forceMemory = false }) {
  if (canStreamToDisk() && !forceMemory) {
    const ext = filename.slice(filename.lastIndexOf('.'));
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Video', accept: { [mimeType]: [ext] } }]
      });
    } catch (err) {
      // AbortError means the user closed the picker; that is a cancel, not a failure.
      if (err?.name === 'AbortError') return null;
      throw err;
    }

    const stream = await handle.createWritable();
    return {
      streaming: true,
      target: new FileSystemWritableFileStreamTarget(stream),
      async finish() {
        await stream.close();
        return null; // already on disk
      },
      async cancel() {
        try {
          await stream.abort();
        } catch {
          /* already closed */
        }
      }
    };
  }

  const target = new (TargetImpl ?? ArrayBufferTarget)();
  return {
    streaming: false,
    target,
    async finish() {
      return new Blob([target.buffer], { type: mimeType });
    },
    async cancel() {}
  };
}

/** Fallback delivery when we could not stream: hand the blob over as a download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
