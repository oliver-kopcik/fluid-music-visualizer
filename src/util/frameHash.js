/**
 * Cheap content hashes, used to prove a render is reproducible.
 *
 * Two levels, because they fail differently:
 *   hashPixels  — what actually reached the screen. Catches everything, but depends on
 *                 GPU float behaviour, so it is only meaningful on one machine.
 *   splat recorder — the inputs we fed the sim. Machine-independent, and the thing that
 *                 actually indicates whether the audio mapping is deterministic.
 */

export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Read back the default framebuffer and hash it. Must be called in the same task as the
 * draw: without preserveDrawingBuffer the buffer is cleared once the browser composites.
 */
export function hashPixels(sim, buffer) {
  const gl = sim.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = buffer && buffer.length === w * h * 4 ? buffer : new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { hash: fnv1a(px), buffer: px };
}

/**
 * Collects every splat the sim performs. Pass `recorder.onSplat` as the `onSplat` option
 * to createFluidSim — wrapping sim.splat from outside would miss the calls multipleSplats
 * and splatPointer make against the closure-local function.
 *
 * This is the determinism check that survives a GPU change: the same track and seed must
 * produce the same splats, whatever the driver then does with them.
 */
export function createSplatRecorder() {
  let calls = [];
  let enabled = true;
  return {
    onSplat(x, y, dx, dy, color) {
      if (!enabled) return;
      calls.push(
        [x, y, dx, dy, color.r, color.g, color.b]
          .map((n) => (Math.round(n * 1e4) / 1e4).toString())
          .join(',')
      );
    },
    get count() {
      return calls.length;
    },
    get hash() {
      return fnv1a(new TextEncoder().encode(calls.join(';')));
    },
    reset() {
      calls = [];
    },
    set enabled(v) {
      enabled = v;
    }
  };
}
