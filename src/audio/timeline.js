/**
 * Read access to the analysis result.
 *
 * Continuous fields are read with sampleAt(), interpolated, so they are safe to call at
 * any frame rate. There used to be a second style alongside it — a cursor walked over the
 * onset list so every onset fired exactly once however fast we rendered. Nothing draws
 * from discrete onsets any more (see mapping/field.js), so it is gone. The onset arrays
 * themselves stay: the debug overlay draws them, and the analysis tests are scored on them.
 */

export class Timeline {
  constructor(data) {
    Object.assign(this, data);
  }

  /**
   * Linear interpolation between adjacent analysis frames.
   *
   * Shifted by frameCenterOffset so continuous features and discrete onsets share one
   * time base: a frame's label is half a window earlier than the audio it describes.
   */
  sampleAt(field, t) {
    const arr = this[field];
    if (!arr || arr.length === 0) return 0;
    const x = (t - (this.frameCenterOffset ?? 0)) * this.frameRate;
    if (x <= 0) return arr[0];
    if (x >= arr.length - 1) return arr[arr.length - 1];
    const i = Math.floor(x);
    const frac = x - i;
    return arr[i] * (1 - frac) + arr[i + 1] * frac;
  }

  /** 32 log-spaced magnitudes for the frame nearest `t`, written into `out`. */
  /**
   * The spectrum at `t`, scaled so every frequency has usable range.
   *
   * The stored curve is scaled by one global maximum, which is what onset pitch needs —
   * it compares one frequency against another. Anything reading a single frequency over
   * time needs the opposite, or a range the track never reaches loudly stays dark forever.
   * Headroom is left above 1 for the same reason normalizeRobust does: peaks should punch
   * through rather than clip flat.
   */
  spectrumAt(t, out) {
    const bins = 32;
    const i = Math.min(this.numFrames - 1, Math.max(0, Math.round(t * this.frameRate)));
    const base = i * bins;
    const reference = this.spectrumReference;
    for (let b = 0; b < bins; b++) {
      const v = this.spectrum32[base + b];
      out[b] = reference ? Math.min(1.6, v / Math.max(1e-6, reference[b])) : v;
    }
    return out;
  }

  /** Reset the walk — call on seek, and before frame 0 of a render. */
  /** Position within the current beat, 0..1, or NaN when the grid isn't trustworthy. */
  beatPhaseAt(t) {
    if (!this.gridUsable || this.beats.length < 2) return NaN;
    const period = 60 / this.tempoBPM;
    const first = this.beats[0];
    const phase = ((t - first) % period) / period;
    return phase < 0 ? phase + 1 : phase;
  }

  /** Which beat index `t` falls in — used to walk the kick burst around the frame. */
  beatIndexAt(t) {
    if (!this.gridUsable || this.beats.length < 2) return -1;
    const period = 60 / this.tempoBPM;
    return Math.floor((t - this.beats[0]) / period);
  }

  /** Seconds to the nearest downbeat, or Infinity when there is no usable grid. */
  nearestDownbeatDistance(t) {
    if (!this.gridUsable || this.downbeats.length === 0) return Infinity;
    let best = Infinity;
    // Downbeats are sparse (one per bar), so a scan from a coarse guess is plenty.
    const period = (60 / this.tempoBPM) * 4;
    const guess = Math.max(0, Math.min(this.downbeats.length - 1, Math.round((t - this.downbeats[0]) / period)));
    for (let i = Math.max(0, guess - 2); i < Math.min(this.downbeats.length, guess + 3); i++) {
      best = Math.min(best, Math.abs(this.downbeats[i] - t));
    }
    return best;
  }
}

const BAND_LABELS = ['low', 'high', 'full'];
