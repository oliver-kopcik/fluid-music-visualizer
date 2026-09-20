/**
 * The simulation settings the app starts from.
 *
 * These used to live in a preset base, alongside per-genre variations that turned out to
 * reach nothing: the atmospheres had taken over every parameter a preset claimed to set,
 * and four presets came to differ in two numbers. What survived is this — the settings
 * that are genuinely fixed for the whole app — and it is applied to the simulation at
 * startup as well as on load, so the idle picture matches the loaded one.
 */
export const SIM_DEFAULTS = {
  DYE_RESOLUTION: 1024,
  SIM_RESOLUTION: 128,
  COLORFUL: false,
  SHADING: true,
  /**
   * Bloom off.
   *
   * It came from upstream, where splats are sparse and a glow around them reads as light.
   * The field fills the frame with dye continuously, so the same glow spreads between
   * neighbouring colours and softens exactly the structure the fluid is there to show.
   * FEEL still drives BLOOM_INTENSITY every frame, so turning it back on from the panel
   * gets the full modulation rather than a flat setting.
   */
  BLOOM: false,
  SUNRAYS: true
};

/**
 * Seconds of lookahead applied when sampling the timeline. Positive makes the visuals
 * lead the audio.
 *
 * Smoothing cannot be free — even a 25ms attack lags by 25ms — and the fluid itself takes
 * a few frames to show a splat as visible motion. Because the whole track is analysed up
 * front we can simply read slightly ahead to cancel that, which a live-only analyser could
 * never do. Audio output latency also varies by machine, so this stays adjustable rather
 * than baked in.
 */
export const DEFAULT_SYNC_OFFSET = 0.045;
