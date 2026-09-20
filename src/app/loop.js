/**
 * The live render loop. This is the only place in the app that reads the wall clock —
 * the offline exporter runs the same per-frame work from an integer frame counter
 * instead (see src/export/offlineLoop.js).
 */

/** Upstream's DPR scaling, moved out of the sim so export can size the canvas exactly. */
export function scaleByPixelRatio(input) {
  const pixelRatio = window.devicePixelRatio || 1;
  return Math.floor(input * pixelRatio);
}

/** Upstream clamped dt to 1/60. Keeping that means live and export agree at 60fps. */
const MAX_DT = 0.016666;

export function createLoop(sim, onFrame) {
  let running = false;
  let rafId = null;
  let lastTime = 0;

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    let dt = (now - lastTime) / 1000;
    if (!Number.isFinite(dt) || dt < 0) dt = MAX_DT;
    dt = Math.min(dt, MAX_DT);
    lastTime = now;

    // Live only: track the element's CSS size. Export pins the backing store and never
    // calls this, so layout cannot resize a render mid-flight.
    const width = scaleByPixelRatio(sim.canvas.clientWidth);
    const height = scaleByPixelRatio(sim.canvas.clientHeight);
    if (width > 0 && height > 0) sim.setSize(width, height);

    onFrame(dt);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
    get running() {
      return running;
    }
  };
}
