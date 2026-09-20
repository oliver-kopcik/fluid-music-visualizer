/**
 * Playback, and the clock the visuals follow.
 *
 * currentTime is derived from AudioContext.currentTime rather than accumulated per frame.
 * An accumulated counter drifts against the audio clock — slowly, but a 3-minute track is
 * long enough that the drop stops landing on the drop.
 *
 * outputLatency is subtracted because AudioContext.currentTime reports what has been
 * *scheduled*, not what has reached the speakers. Without it the visuals lead the sound
 * by 20-40 ms, which reads as the visualizer firing slightly early.
 */
import { getAudioContext } from './decode.js';

export function createPlayer() {
  const ctx = getAudioContext();
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();

  // Our own smoothing is dt-correct; the built-in constant is not.
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;

  gain.connect(analyser);
  analyser.connect(ctx.destination);

  let buffer = null;
  let source = null;
  let startedAt = 0; // ctx time when playback of `offset` began
  let offset = 0; // seconds into the track
  let playing = false;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn(api);
  }

  function stopSource() {
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
    source = null;
  }

  const api = {
    analyser,

    get duration() {
      return buffer ? buffer.duration : 0;
    },
    get playing() {
      return playing;
    },

    get currentTime() {
      if (!buffer) return 0;
      if (!playing) return offset;
      const latency = ctx.outputLatency || ctx.baseLatency || 0;
      const t = offset + (ctx.currentTime - startedAt) - latency;
      return Math.max(0, Math.min(buffer.duration, t));
    },

    load(audioBuffer) {
      stopSource();
      buffer = audioBuffer;
      offset = 0;
      playing = false;
      emit();
    },

    async play() {
      if (!buffer || playing) return;
      if (ctx.state === 'suspended') await ctx.resume();

      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => {
        if (!playing) return;
        playing = false;
        offset = buffer.duration;
        emit();
      };
      startedAt = ctx.currentTime;
      source.start(0, offset);
      playing = true;
      emit();
    },

    pause() {
      if (!playing) return;
      offset = api.currentTime;
      playing = false;
      stopSource();
      emit();
    },

    toggle() {
      return playing ? api.pause() : api.play();
    },

    seek(t) {
      if (!buffer) return;
      const target = Math.max(0, Math.min(buffer.duration, t));
      if (playing) {
        stopSource();
        offset = target;
        playing = false;
        api.play();
      } else {
        offset = target;
        emit();
      }
    },

    setVolume(v) {
      gain.gain.value = v;
    },

    /** So the export path can pull the decoded audio for its own track. */
    get buffer() {
      return buffer;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    connectTo(node) {
      analyser.connect(node);
    }
  };

  return api;
}
