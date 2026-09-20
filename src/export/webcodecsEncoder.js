/**
 * WebCodecs encoding, with the muxer wired to a streaming sink.
 *
 * The reason this path exists rather than ffmpeg.wasm is memory, not speed. A 3-minute
 * 1080p60 render is 10,800 frames and raw RGBA is 8.29 MB per frame — 89 GB if buffered.
 * `new VideoFrame(canvas)` is GPU-backed, goes straight to the encoder and is closed
 * immediately, so only a bounded queue is ever live. Hardware AVC also runs far above
 * realtime, where x264 in WASM manages roughly 5-20 fps at 1080p.
 */
import { Muxer } from 'mp4-muxer';

/** Tried in order. Falls back through profiles before giving up on MP4 entirely. */
const VIDEO_CANDIDATES = [
  { codec: 'avc1.640028', muxer: 'avc', label: 'H.264 High' },
  { codec: 'avc1.4d0028', muxer: 'avc', label: 'H.264 Main' },
  { codec: 'avc1.42001f', muxer: 'avc', label: 'H.264 Baseline' },
  { codec: 'vp09.00.10.08', muxer: 'vp9', label: 'VP9' }
];

export const hasWebCodecs = () =>
  typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';

export async function pickVideoCodec({ width, height, framerate, bitrate }) {
  if (!hasWebCodecs()) return null;
  for (const candidate of VIDEO_CANDIDATES) {
    const config = {
      codec: candidate.codec,
      width,
      height,
      framerate,
      bitrate,
      bitrateMode: 'variable',
      latencyMode: 'quality',
      ...(candidate.muxer === 'avc' ? { avc: { format: 'avc' } } : {})
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support?.supported) return { ...candidate, config: support.config ?? config };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

async function pickAudioCodec({ sampleRate, numberOfChannels, bitrate }) {
  if (typeof window.AudioEncoder !== 'function') return null;
  for (const codec of ['mp4a.40.2']) {
    const config = { codec, sampleRate, numberOfChannels, bitrate };
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      if (support?.supported) return support.config ?? config;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Bounded backpressure via the `dequeue` event.
 *
 * Polling encodeQueueSize in a loop burns the very thread the encoder needs. The yield
 * is a MessageChannel ping rather than setTimeout: Chrome clamps timers to 1000ms in
 * backgrounded tabs, so a minimised export would crawl at one frame per second.
 */
const channel = new MessageChannel();
export function yieldToEventLoop() {
  return new Promise((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}

function awaitQueue(encoder, max) {
  if (encoder.encodeQueueSize <= max) return yieldToEventLoop();
  return new Promise((resolve) => {
    const onDequeue = () => {
      if (encoder.encodeQueueSize <= max) {
        encoder.removeEventListener('dequeue', onDequeue);
        resolve();
      }
    };
    encoder.addEventListener('dequeue', onDequeue);
  });
}

export async function createEncoder({ width, height, fps, videoBitrate, audioBuffer, sink, onError }) {
  const video = await pickVideoCodec({ width, height, framerate: fps, bitrate: videoBitrate });
  if (!video) throw new Error('No supported video codec — WebCodecs unavailable or rejected every profile.');

  const wantAudio = !!audioBuffer;
  const audioConfig = wantAudio
    ? await pickAudioCodec({
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: Math.min(2, audioBuffer.numberOfChannels),
        bitrate: 192000
      })
    : null;

  const muxer = new Muxer({
    target: sink.target,
    video: { codec: video.muxer, width, height, frameRate: fps },
    ...(audioConfig
      ? {
          audio: {
            codec: 'aac',
            numberOfChannels: audioConfig.numberOfChannels,
            sampleRate: audioConfig.sampleRate
          }
        }
      : {}),
    // moov at the end. Cheaper and exact for a local file; nothing here is streamed to a
    // player while it is being written.
    fastStart: false
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => onError?.(e)
  });
  videoEncoder.configure(video.config);

  let audioEncoder = null;
  if (audioConfig) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => onError?.(e)
    });
    audioEncoder.configure(audioConfig);
  }

  return {
    codecLabel: video.label,
    hasAudio: !!audioEncoder,

    /** One frame, captured straight off the canvas. */
    async addFrame(canvas, frameIndex) {
      const timestamp = Math.round((frameIndex * 1e6) / fps);
      const duration = Math.round(1e6 / fps);
      let frame;
      try {
        frame = new VideoFrame(canvas, { timestamp, duration, alpha: 'discard' });
      } catch {
        // Some drivers refuse a WebGL canvas directly; an ImageBitmap always works.
        const bitmap = await createImageBitmap(canvas);
        frame = new VideoFrame(bitmap, { timestamp, duration, alpha: 'discard' });
        bitmap.close();
      }
      // A keyframe every 2s keeps the file seekable without hurting size much.
      videoEncoder.encode(frame, { keyFrame: frameIndex % (fps * 2) === 0 });
      frame.close();
      await awaitQueue(videoEncoder, 4);
    },

    /**
     * Encode the whole audio track up front, in one pass.
     *
     * Interleaving it with the video loop would have the two encoders competing for the
     * same thread for the entire render; a 3-minute track is ~8,000 packets and takes
     * well under a second on its own.
     */
    async encodeAudio(seconds) {
      if (!audioEncoder) return;
      const sr = audioBuffer.sampleRate;
      const channels = Math.min(2, audioBuffer.numberOfChannels);
      const total = Math.min(audioBuffer.length, Math.ceil(seconds * sr));
      const CHUNK = 1024;

      const planes = [];
      for (let c = 0; c < channels; c++) planes.push(audioBuffer.getChannelData(c));

      const interleavedPlanar = new Float32Array(CHUNK * channels);
      for (let offset = 0; offset < total; offset += CHUNK) {
        const count = Math.min(CHUNK, total - offset);
        for (let c = 0; c < channels; c++) {
          interleavedPlanar.set(planes[c].subarray(offset, offset + count), c * count);
        }
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: sr,
          numberOfFrames: count,
          numberOfChannels: channels,
          timestamp: Math.round((offset / sr) * 1e6),
          data: interleavedPlanar.subarray(0, count * channels)
        });
        audioEncoder.encode(data);
        data.close();
        if ((offset / CHUNK) % 64 === 0) await yieldToEventLoop();
      }
    },

    async finish() {
      await videoEncoder.flush();
      if (audioEncoder) await audioEncoder.flush();
      muxer.finalize();
      videoEncoder.close();
      audioEncoder?.close();
    },

    abort() {
      try {
        videoEncoder.close();
      } catch {
        /* already closed */
      }
      try {
        audioEncoder?.close();
      } catch {
        /* already closed */
      }
    }
  };
}
