/**
 * The one place a frame is produced.
 *
 * Live playback and the offline exporter both call this, and they differ only in the
 * arguments they pass. If the two ever grew their own copies of this sequence, an export
 * would stop matching what you tuned on screen — which is exactly the bug the whole
 * determinism effort exists to prevent.
 */

/**
 * @param sim       the fluid simulation
 * @param ctx.mapping     audio → fluid mapping layer (null before a track is loaded)
 * @param ctx.features    per-frame audio features; `live` is null during export
 * @param ctx.interactive whether pointer input should be drained (never during export)
 * @param t         seconds into the track
 * @param dt        seconds this frame advances the simulation
 */
export function renderFrame(sim, ctx, t, dt) {
  if (ctx.mapping) ctx.mapping.applyFrame(sim, ctx.features, t, dt);

  sim.updateColors(dt);

  // Export never drains pointers, so a stray mouse movement cannot contaminate a render.
  if (ctx.interactive) sim.applyInputs();

  if (!sim.config.PAUSED) sim.step(dt);
  sim.render(null);
}
