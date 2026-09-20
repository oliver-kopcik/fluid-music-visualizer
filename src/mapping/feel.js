/**
 * FEEL — sweeps the simulation's own parameters.
 *
 * FLOW and HITS add energy; this changes how the fluid *behaves* with it. Loud passages
 * get long trails and heavy bloom, quiet ones get short trails and calm. It is the layer
 * that makes a drop feel different rather than just busier.
 *
 * Everything here goes through setConfigFast, which throws on any key that would
 * reallocate framebuffers — writing DYE_RESOLUTION per frame would wipe the dye 60 times
 * a second, and the failure mode (a black screen) is far from the cause.
 */
import { OnePole, Envelope, lerp, clamp01 } from './smoothers.js';

export function createFeel(config) {
  const curl = new OnePole(0.07, 30);
  const radius = new OnePole(0.06, 0.25);
  const density = new OnePole(0.15, 1);
  const velocity = new OnePole(0.15, 0.2);
  const pressure = new OnePole(0.08, 0.8);
  const bloom = new Envelope(0.02, 0.18, 0.8);
  const sunrays = new OnePole(0.12, 1);

  const patch = {};

  function reset() {
    curl.reset(30);
    radius.reset(0.25);
    density.reset(1);
    velocity.reset(0.2);
    pressure.reset(0.8);
    bloom.reset(0.8);
    sunrays.reset(1);
  }

  function apply(sim, f, dt, { radiusBoost = 0, bloomFlash = 0 } = {}, arc) {
    const r = config.ranges ?? {};
    const mid = clamp01(f.mid);
    const rms = clamp01(f.rms);
    const rmsSlow = clamp01(f.rmsSlow);
    const bassSlow = clamp01(f.bassSlow);
    arc = arc ?? { coil: 0, burst: 0, intensity: 1 };

    /**
     * Curl is the main "posture" parameter. A coil winds it right up so the picture
     * visibly tightens before a drop; the burst that follows relaxes it, which reads as
     * the tension letting go.
     */
    patch.CURL = curl.step(
      lerp(r.curlMin ?? 18, r.curlMax ?? 48, mid) *
        (1 + 0.5 * clamp01(f.trebleFast - 0.5)) *
        (1 + 1.4 * arc.coil - 0.25 * arc.burst),
      dt
    );

    // The smoothed base, plus this frame's kick transient applied on top rather than
    // through the filter — the whole point of the bump is that it is instant.
    const baseRadius = radius.step(lerp(r.radiusMin ?? 0.18, r.radiusMax ?? 0.34, bassSlow), dt);
    patch.SPLAT_RADIUS = baseRadius * (1 + radiusBoost);

    /**
     * Trails lengthen with the arc, not just the level. During a coil the dye is cleared
     * faster so the screen darkens into the drop, and the burst then leaves long streaks
     * behind it — the contrast between those two is most of what makes a drop land.
     */
    patch.DENSITY_DISSIPATION = density.step(
      lerp(r.densityQuiet ?? 7.5, r.densityLoud ?? 5, rmsSlow) *
        (1 + 0.55 * arc.coil) *
        (1 - 0.35 * arc.burst),
      dt
    );
    patch.VELOCITY_DISSIPATION = velocity.step(lerp(0.35, 0.12, rmsSlow), dt);
    patch.PRESSURE = pressure.step(0.8 - 0.15 * clamp01(f.bass), dt);

    /**
     * Bloom is the fastest way to destroy this picture, so it is modulated gently and
     * deliberately stays near upstream's 0.8 default.
     *
     * The first version swept intensity to 0.45 + 1.1*rms + flash (up to ~2.75, over 3x
     * the default) while *lowering* the threshold as the track got louder. That washed
     * every bright passage to flat white. Lowering the threshold on loud material is
     * backwards: loud already means more dye and brighter pixels, so it double-counts.
     * The threshold now rises slightly with level, which holds the highlights together.
     */
    patch.BLOOM_INTENSITY = bloom.step(
      (r.bloomBase ?? 0.5) + 0.45 * rms * arc.intensity + bloomFlash + 0.5 * arc.burst,
      dt
    );
    patch.BLOOM_THRESHOLD = 0.6 + 0.1 * rms;
    patch.SUNRAYS_WEIGHT = sunrays.step(0.6 + 0.9 * clamp01(f.centroid), dt);

    sim.setConfigFast(patch);
  }

  return { apply, reset };
}
