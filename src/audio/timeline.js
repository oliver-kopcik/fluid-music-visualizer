/**
 * Read access to the analysis result.
 *
 * Two lookup styles, and the distinction matters:
 *   sampleAt()      continuous fields, interpolated — safe to call at any frame rate.
 *   onsetsBetween() discrete events, cursor-walked over the half-open interval (tPrev, t].
 *
 * Interpolating onsets would smear them; sampling them at frame times would drop the ones
 * that fall between frames and double-fire the ones near a boundary. Walking a cursor
 * means every onset fires exactly once whether we are rendering at 30, 60 or 120 fps —
 * which is what lets the offline export match the live preview.
 */

export class Timeline {
  constructor(data) {
    Object.assign(this, data);
    this._cursor = 0;
    // Onset records are consumed within the frame that produced them, so they can be
    // pooled rather than allocated fresh each time one fires.
    this._pool = [];
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
  spectrumAt(t, out) {
    const bins = 32;
    const i = Math.min(this.numFrames - 1, Math.max(0, Math.round(t * this.frameRate)));
    const base = i * bins;
    for (let b = 0; b < bins; b++) out[b] = this.spectrum32[base + b];
    return out;
  }

  /** Reset the walk — call on seek, and before frame 0 of a render. */
  resetCursor(t = 0) {
    this._cursor = 0;
    while (this._cursor < this.onsetTimes.length && this.onsetTimes[this._cursor] <= t) this._cursor++;
  }

  /** Every onset in (tPrev, t]. Allocation-free when nothing fired, which is most frames. */
  onsetsBetween(tPrev, t, out = []) {
    out.length = 0;
    if (t < tPrev) {
      this.resetCursor(t);
      return out;
    }
    while (this._cursor < this.onsetTimes.length && this.onsetTimes[this._cursor] <= t) {
      const i = this._cursor;
      if (this.onsetTimes[i] > tPrev) {
        let rec = this._pool[out.length];
        if (!rec) rec = this._pool[out.length] = { t: 0, strength: 0, band: 'full', index: 0, pitch: 0.5, noise: 0.5 };
        rec.t = this.onsetTimes[i];
        rec.strength = this.onsetStrengths[i];
        rec.band = BAND_LABELS[this.onsetBands[i]];
        rec.pitch = this.onsetPitch?.[i] ?? 0.5;
        rec.noise = this.onsetNoise?.[i] ?? 0.5;
        rec.index = i;
        out.push(rec);
      }
      this._cursor++;
    }
    return out;
  }

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
