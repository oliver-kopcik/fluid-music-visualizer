/**
 * Deterministic offline render.
 *
 * This is what all the determinism work was for. The loop is driven by an integer frame
 * counter with a fixed dt and never reads the wall clock, so a slow GPU produces the same
 * frames as a fast one — just later. Frames cannot be dropped, because nothing here is
 * tied to a display refresh.
 *
 * Every source of nondeterminism has to be closed before frame 0:
 *   - the sim's RNG is seeded from the track content (see util/rng.js)
 *   - the dithering texture must have loaded, or the first frames use a 1x1 placeholder
 *   - the dye and velocity fields are cleared, so a live preview leaves nothing behind
 *   - pointer input is never drained, so a stray mouse move cannot contaminate a render
 *   - the canvas is pinned to the export size and never resized mid-render
 */
import { createFluidSim } from '../fluid/fluidCore.js';
import { SIM_DEFAULTS } from '../app/simDefaults.js';
import { createMapping } from '../mapping/index.js';
import { makeStreams } from '../util/rng.js';
import { createSink, downloadBlob, estimateBytes, canStreamToDisk } from './fileSink.js';
import { createEncoder, hasWebCodecs, yieldToEventLoop } from './webcodecsEncoder.js';

export const RESOLUTIONS = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440]
};

/**
 * The deterministic frame loop, shared by the exporter and the verifier below.
 *
 * Both must drive the simulation identically, or verifying one says nothing about the
 * other — the same reason renderFrame() is shared by the live loop and the mapping.
 *
 * Renders on its own canvas and GL context rather than borrowing the live one. Sharing
 * would mean resizing the visible canvas mid-render and risking layout resetting the
 * backing store; a separate context also lets the preview keep running.
 *
 * The caller disposes `sim`, since it may still need to read from the canvas.
 */
export async function driveFrames(
  { timeline, seed, width, height, fps, dyeResolution = 1024, startTime = 0, totalFrames, signal },
  onFrame
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const streams = makeStreams(seed);
  const sim = createFluidSim(canvas, { rng: streams.rngSim, initialSplats: 0 });

  // Frame 0 must not run against the placeholder dithering texture.
  await sim.ready;
  sim.setConfig({ ...SIM_DEFAULTS, DYE_RESOLUTION: dyeResolution, PAUSED: false, TRANSPARENT: false });
  sim.setSize(width, height);
  sim.clear();

  const mapping = createMapping({ timeline, rng: streams.rngMap });
  mapping.reset(startTime);

  // `interactive` is never set, so applyInputs is never called and no pointer state can
  // reach a render. `playing` is explicit: the mapping must drive regardless of the page.
  const features = { live: null, playing: true };
  const dt = 1 / fps;

  for (let frame = 0; frame < totalFrames; frame++) {
    if (signal?.aborted) return { canvas, sim, aborted: true, frame };
    mapping.applyFrame(sim, features, startTime + frame * dt, dt);
    sim.step(dt);
    sim.render(null);
    const keepGoing = await onFrame(canvas, frame, sim);
    if (keepGoing === false) return { canvas, sim, aborted: true, frame };
  }
  return { canvas, sim, aborted: false, frame: totalFrames };
}

export async function renderToFile({
  timeline,
  audioBuffer,
  seed,
  resolution = '1080p',
  fps = 60,
  videoBitrate = 20_000_000,
  dyeResolution = 1024,
  startTime = 0,
  duration = null,
  filename = 'fluid.mp4',
  onProgress = () => {},
  signal = null,
  /** Return the bytes instead of saving them. Used by the tests to inspect output. */
  deliver = true
}) {
  if (!hasWebCodecs()) {
    throw new Error('This browser has no WebCodecs support. Use the quick recording instead.');
  }

  const [width, height] = RESOLUTIONS[resolution] ?? RESOLUTIONS['1080p'];
  const seconds = Math.max(0.1, duration ?? timeline.duration - startTime);
  const totalFrames = Math.round(seconds * fps);

  if (!canStreamToDisk() && deliver) {
    const mb = estimateBytes({ seconds, videoBitrate }) / 1e6;
    if (mb > 400) {
      throw new Error(
        `This browser cannot stream to disk, so the whole ${Math.round(mb)} MB file must be held ` +
          `in memory. Shorten the render, lower the bitrate, or use a browser with the File ` +
          `System Access API.`
      );
    }
  }

  const sink = await createSink({ filename, mimeType: 'video/mp4', forceMemory: !deliver });
  if (!sink) return { cancelled: true }; // user dismissed the save dialog

  let wakeLock = null;
  let encoder = null;
  let encoderFailed = false;

  try {
    encoder = await createEncoder({
      width,
      height,
      fps,
      videoBitrate,
      audioBuffer,
      sink,
      onError: (e) => {
        encoderFailed = true;
        console.error('encoder error', e);
      }
    });

    // Audio first, in one pass, so the two encoders never compete for the thread.
    onProgress({ phase: 'audio', progress: 0, frame: 0, totalFrames });
    await encoder.encodeAudio(seconds);

    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* not fatal */
    }

    const started = performance.now();
    const run = await driveFrames(
      { timeline, seed, width, height, fps, dyeResolution, startTime, totalFrames, signal },
      async (canvas, frame) => {
        if (encoderFailed) return false;
        await encoder.addFrame(canvas, frame);
        if ((frame & 7) === 0) {
          const elapsed = (performance.now() - started) / 1000;
          const rate = frame > 0 ? frame / elapsed : 0;
          onProgress({
            phase: 'video',
            progress: frame / totalFrames,
            frame,
            totalFrames,
            fps: rate,
            etaSeconds: rate > 0 ? (totalFrames - frame) / rate : null
          });
        }
        return true;
      }
    );

    const contextLost = run.sim.gl.isContextLost();
    run.sim.dispose();

    if (run.aborted || encoderFailed) {
      encoder.abort();
      await sink.cancel();
      return { cancelled: true, contextLost };
    }

    onProgress({ phase: 'finalizing', progress: 1, frame: totalFrames, totalFrames });
    await encoder.finish();
    const blob = await sink.finish();
    if (blob && deliver) downloadBlob(blob, filename);

    return {
      cancelled: false,
      blob: deliver ? null : blob,
      frames: totalFrames,
      width,
      height,
      fps,
      codec: encoder.codecLabel,
      hasAudio: encoder.hasAudio,
      streamed: sink.streaming,
      seconds: (performance.now() - started) / 1000
    };
  } catch (err) {
    encoder?.abort();
    await sink.cancel();
    throw err;
  } finally {
    wakeLock?.release?.().catch(() => {});
    await yieldToEventLoop();
  }
}

/**
 * Prove the render loop is deterministic, at the level where it actually matters.
 *
 * Comparing encoded MP4 bytes does NOT work. Hardware H.264 rate control adapts run to
 * run, so two renders of identical frames differ by around a kilobyte in file size —
 * measured at 3,839,812 vs 3,838,265 bytes for the same seed. That is a property of the
 * encoder, not of this loop, and treating it as a failure would hide the real question:
 * are the frames the same?
 *
 * So this hashes the pixels the loop produced, before anything is encoded.
 */
export async function verifyRenderDeterminism({
  timeline,
  seed = 0x5eed,
  startTime = 0,
  seconds = 3,
  fps = 60,
  width = 320,
  height = 180
}) {
  const totalFrames = Math.round(seconds * fps);

  const once = async (useSeed) => {
    const hashes = [];
    let buffer = null;
    const run = await driveFrames(
      { timeline, seed: useSeed, width, height, fps, dyeResolution: 512, startTime, totalFrames },
      (canvas, frame, sim) => {
        const gl = sim.gl;
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        // Must read in the same task as the draw: without preserveDrawingBuffer the
        // buffer is cleared once the browser composites.
        if (!buffer || buffer.length !== w * h * 4) buffer = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
        let hash = 0x811c9dc5;
        for (let i = 0; i < buffer.length; i += 4) {
          hash ^= buffer[i];
          hash = Math.imul(hash, 0x01000193);
        }
        hashes.push(hash >>> 0);
        return true;
      }
    );
    run.sim.dispose();
    return hashes;
  };

  const a = await once(seed);
  const b = await once(seed);
  const c = await once(seed + 1);

  let firstDivergence = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      firstDivergence = i;
      break;
    }
  }

  return {
    frames: totalFrames,
    identical: firstDivergence === -1,
    firstDivergence,
    matchingFrames: firstDivergence === -1 ? totalFrames : firstDivergence,
    seedChangesOutput: a.some((v, i) => v !== c[i])
  };
}

/**
 * Sidecar metadata, so a render can be reproduced later.
 *
 * Determinism is only useful if you can still say what produced a given file — seed,
 * seed and the GL extension set all change the output.
 */
export function renderSidecar({ timeline, seed, result }) {
  return {
    track: timeline.name,
    duration: timeline.duration,
    analysisVersion: timeline.version,
    seed,
    tempoBPM: timeline.tempoBPM,
    gridUsable: timeline.gridUsable,
    profile: timeline.profile,
    ...result
  };
}
