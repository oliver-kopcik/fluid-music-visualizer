/**
 * The per-frame feature bundle the three mapping layers share.
 *
 * Reads the precomputed timeline and smooths it. Deliberately allocation-free: this runs
 * 60 times a second live and ~10,800 times during a 3-minute export.
 */
import { OnePole, Envelope, clamp, clamp01 } from './smoothers.js';

export function createFeatureReader() {
/**
 * Time constants are the whole sync budget.
 *
 * A one-pole lags a ramp by roughly its time constant, so anything driving visible motion
 * has to stay far below a beat. The first version ran the two bass emitters — the most
 * prominent things on screen — off a 400ms filter, which at 120 BPM put them most of a
 * beat behind the music and read as plainly out of sync. Attack times now sit at 25-40ms;
 * only the parameters that want to feel like slow swells keep long constants, and those
 * are things like dissipation where lag is invisible.
 */
  const bassFast = new Envelope(0.025, 0.1);
  const bassSlow = new OnePole(0.35);
  const midSm = new OnePole(0.035);
  const trebleFast = new Envelope(0.02, 0.08);
  const rmsSm = new OnePole(0.04);
  const rmsSlow = new OnePole(0.3);
  const centroidSm = new OnePole(0.06, 0.5);
  const sustainSm = new OnePole(0.12);

  // Centroid history, for the pitch-derivative steering term.
  const CENTROID_LAG = 0.1; // seconds
  let centroidHistory = [];

  const f = {
    t: 0,
    bass: 0, bassFast: 0, bassSlow: 0, bassDrive: 0,
    mid: 0, treble: 0, trebleFast: 0,
    rms: 0, rmsSlow: 0,
    centroid: 0.5, centroidSlope: 0,
    sustain: 0,
    activity: 0,
    beatPhase: NaN,
    beatIndex: -1,
    profile: 'full',
    onsets: [],
    spectrum: new Float32Array(32)
  };

  function reset() {
    for (const s of [bassFast, bassSlow, midSm, trebleFast, rmsSm, rmsSlow, sustainSm]) s.reset(0);
    centroidSm.reset(0.5);
    centroidHistory = [];
  }

  /**
   * @param live  AnalyserNode-derived detail, or null during export. The timeline alone
   *              must be enough to produce the same picture, so `live` may only ever add
   *              a small high-frequency term — never change structure.
   */
  function read(timeline, t, dt, tPrev, live = null) {
    f.t = t;
    f.profile = timeline.profile;

    const rawBass = timeline.sampleAt('bass', t);
    const rawMid = timeline.sampleAt('mid', t);
    const rawTreble = timeline.sampleAt('treble', t);
    const rawRms = timeline.sampleAt('rms', t);

    f.bass = rawBass;
    f.bassFast = bassFast.step(rawBass, dt);
    f.bassSlow = bassSlow.step(rawBass, dt);
    // What the emitters actually ride: mostly the fast envelope so it lands with the
    // music, with a little of the slow one for body.
    f.bassDrive = 0.78 * f.bassFast + 0.22 * f.bassSlow;
    f.mid = midSm.step(rawMid, dt);
    f.treble = rawTreble;
    f.trebleFast = trebleFast.step(rawTreble + (live ? live.trebleDetail * 0.25 : 0), dt);
    f.rms = rmsSm.step(rawRms, dt);
    f.rmsSlow = rmsSlow.step(rawRms, dt);
    f.sustain = sustainSm.step(timeline.sampleAt('sustain', t), dt);

    // centroidPalette, not centroidNorm — see the worker: the absolute curve barely
    // moves within a single track, so the palette would sit on one hue.
    const centroid = centroidSm.step(timeline.sampleAt('centroidPalette', t), dt);
    f.centroid = centroid;

    // Rate of change of brightness over ~100ms. Rising lines sweep the flow outward,
    // falling lines pull it in; on a sustained lead this is what makes the motion track
    // the melody rather than just its loudness.
    centroidHistory.push({ t, v: centroid });
    while (centroidHistory.length > 2 && t - centroidHistory[0].t > CENTROID_LAG) centroidHistory.shift();
    const oldest = centroidHistory[0];
    const span = Math.max(1e-3, t - oldest.t);
    f.centroidSlope = clamp((centroid - oldest.v) / span, -3, 3);

    f.beatPhase = timeline.beatPhaseAt(t);
    f.beatIndex = timeline.beatIndexAt(t);

    timeline.onsetsBetween(tPrev, t, f.onsets);
    timeline.spectrumAt(t, f.spectrum);

    // Never zero: silence should read as calm, not frozen.
    f.activity = Math.max(f.rms, f.sustain, 0.12);

    return f;
  }

  return { read, reset, features: f };
}

export { clamp01 };
