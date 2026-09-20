/**
 * Worker wrapper + cache. Analysis is deterministic for a given file, so re-opening a
 * track should be instant rather than a second of work you've already paid for.
 */
import { Timeline } from './timeline.js';
import { hashString } from '../util/rng.js';
import { cacheGet, cachePut } from '../util/idb.js';

export async function analyzeTrack({ mono, name, sampleRate }, onProgress = () => {}) {
  // Key on content, not filename: renaming a file shouldn't invalidate it, and two copies
  // of the same track shouldn't be analysed twice.
  const key = 'v7:' + contentKey(mono, name);

  const cached = await cacheGet(key);
  if (cached) {
    onProgress(1);
    return { timeline: new Timeline(cached), seed: hashString(key), cached: true };
  }

  const timeline = await runWorker(mono, sampleRate, name, onProgress);
  await cachePut(key, timeline);
  return { timeline: new Timeline(timeline), seed: hashString(key), cached: false };
}

/** Sample the signal rather than hashing 8M floats — enough to distinguish tracks. */
function contentKey(mono, name) {
  let h = 0x811c9dc5;
  const stride = Math.max(1, Math.floor(mono.length / 4096));
  for (let i = 0; i < mono.length; i += stride) {
    h ^= Math.round(mono[i] * 32767) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return `${name}:${mono.length}:${(h >>> 0).toString(16)}`;
}

function runWorker(mono, sampleRate, name, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analyze.worker.js', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') return onProgress(msg.progress);
      if (msg.type === 'error') {
        worker.terminate();
        return reject(new Error(msg.message));
      }
      if (msg.type === 'done') {
        worker.terminate();
        onProgress(1);
        return resolve(msg.timeline);
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message || 'analysis worker failed'));
    };

    // Copy: the caller still needs `mono` for nothing, but the AudioBuffer it came from
    // may be reused, and a detached view is a confusing failure to debug.
    const copy = mono.slice();
    worker.postMessage({ samples: copy.buffer, sampleRate, name }, [copy.buffer]);
  });
}
