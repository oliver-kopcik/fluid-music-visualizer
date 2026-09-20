/**
 * FEEL — sweeps the simulation's own parameters.
 *
 * Two things stack here. The *atmosphere* sets what the fluid fundamentally is for this
 * section — viscous and gliding, or crisp and percussive — and the audio then modulates
 * around that base. So a section change alters the medium itself, while the music within
 * a section alters what happens in it.
 *
 * Velocity diffusion is the most expressive knob in the whole simulation and was the most
 * neglected: at 0.04 momentum carries for seconds and everything becomes long gliding
 * streamers; at 0.55 motion dies on contact and each hit stays a separate legible mark.
 * Driving it from loudness alone wasted nearly all of that range.
 *
 * Everything goes through setConfigFast, which throws on any key that would reallocate
 * framebuffers — writing DYE_RESOLUTION per frame would wipe the dye 60 times a second,
 * and the failure mode (a black screen) is a long way from the cause.
 */
import { OnePole, Envelope, lerp, clamp, clamp01 } from './smoothers.js';

/**
 * Hard limits, applied after every modulation.
 *
 * Without them the stacked multipliers ran away: curl reached ~156 against upstream's
 * slider maximum of 50, which is past the point where vorticity confinement stops looking
 * like fluid and starts looking like noise.
 */
const LIMITS = {
  CURL: [4, 90],
  SPLAT_RADIUS: [0.05, 0.9],
  DENSITY_DISSIPATION: [0.5, 30],
  VELOCITY_DISSIPATION: [0.01, 1.6],
  PRESSURE: [0.3, 0.99],
  BLOOM_INTENSITY: [0.05, 1.15],
  BLOOM_THRESHOLD: [0.2, 0.95],
  SUNRAYS_WEIGHT: [0.1, 2]
};

const limit = (key, value) => clamp(value, LIMITS[key][0], LIMITS[key][1]);

export function createFeel(config) {
  // Anything shaping a splat as it lands must track the music; slow swells can stay slow.
  const curl = new OnePole(0.07, 30);
  const radius = new OnePole(0.06, 0.25);
  const density = new OnePole(0.25, 1);
  const velocity = new OnePole(0.35, 0.2);
  const pressure = new OnePole(0.3, 0.8);
  const bloom = new Envelope(0.02, 0.18, 0.45);
  const sunrays = new OnePole(0.25, 1);

  const patch = {};

  function reset() {
    curl.reset(30);
    radius.reset(0.25);
    density.reset(1);
    velocity.reset(0.2);
    pressure.reset(0.8);
    bloom.reset(0.45);
    sunrays.reset(1);
  }

  function applyFeel(sim, f, dt, { radiusBoost = 0, bloomFlash = 0 } = {}, arc) {
    arc = arc ?? { coil: 0, burst: 0, intensity: 1, atmosphere: null };
    const atmos = arc.atmosphere ?? {};

    const mid = clamp01(f.mid);
    const rms = clamp01(f.rms);
    const rmsSlow = clamp01(f.rmsSlow);
    const bassSlow = clamp01(f.bassSlow);

    const curlBase = atmos.curl ?? lerp(18, 48, mid);
    const velBase = atmos.velocity ?? 0.2;
    const pressBase = atmos.pressure ?? 0.8;
    const densBase = atmos.density ?? lerp(7.5, 5, rmsSlow);
    const radBase = atmos.radius ?? 0.25;
    const bloomBase = atmos.bloom ?? 0.5;
    const sunBase = atmos.sunrays ?? 1;

    /**
     * Curl is the main posture parameter. A coil winds it up so the picture visibly
     * tightens before a drop; the burst that follows relaxes it, which reads as the
     * tension letting go.
     */
    patch.CURL = limit(
      'CURL',
      curl.step(
        curlBase *
          (0.75 + 0.6 * mid) *
          (1 + 0.45 * clamp01(f.trebleFast - 0.5)) *
          (1 + 0.9 * arc.coil - 0.2 * arc.burst),
        dt
      )
    );

    /**
     * Velocity diffusion: the atmosphere's identity, pushed a little by level. Loud
     * passages hold momentum slightly longer than quiet ones within the same section.
     */
    patch.VELOCITY_DISSIPATION = limit(
      'VELOCITY_DISSIPATION',
      velocity.step(velBase * (1.25 - 0.45 * rmsSlow) * (1 - 0.3 * arc.burst), dt)
    );

    // Loose pressure reads as turbulent. Bass and bursts both loosen it.
    patch.PRESSURE = limit(
      'PRESSURE',
      pressure.step(pressBase - 0.12 * clamp01(f.bass) - 0.08 * arc.burst, dt)
    );

    // The smoothed base, plus this frame's kick transient applied on top rather than
    // through the filter — the whole point of the bump is that it is instant.
    const baseRadius = radius.step(radBase * (0.85 + 0.35 * bassSlow), dt);
    patch.SPLAT_RADIUS = limit('SPLAT_RADIUS', baseRadius * (1 + radiusBoost));

    /**
     * Trails follow the arc, not just the level. A coil clears the dye faster so the
     * screen darkens into the drop; the burst then leaves long streaks behind it, and the
     * contrast between those two is most of what makes a drop land.
     */
    patch.DENSITY_DISSIPATION = limit(
      'DENSITY_DISSIPATION',
      density.step(densBase * (1.1 - 0.3 * rmsSlow) * (1 + 0.5 * arc.coil) * (1 - 0.3 * arc.burst), dt)
    );

    /**
     * Every bloom term was tuned against a picture that no longer exists.
     *
     * The old layers splatted six emitters plus discrete hits; the field runs a dozen
     * readers continuously, so far more dye is on screen at any moment and the same bloom
     * setting glares where it used to glow. The terms used to sum to 2.15 at a drop —
     * clamped to 1.6, against upstream's default of 0.8 — with the ceiling doing the
     * tuning, which meant every loud passage arrived at exactly the same blown-out value
     * and none of the modulation here could be seen at all. They now sum to about 0.43
     * typically and 1.14 at the loudest, so the ceiling is a safety limit again rather
     * than the thing setting the look.
     */
    patch.BLOOM_INTENSITY = limit(
      'BLOOM_INTENSITY',
      bloom.step(bloomBase + 0.18 * rms * arc.intensity + 0.5 * bloomFlash + 0.22 * arc.burst, dt)
    );
    // Rises with level, so a loud passage blooms only its brightest cores rather than
    // lighting the whole frame.
    patch.BLOOM_THRESHOLD = limit('BLOOM_THRESHOLD', 0.68 + 0.14 * rms);
    patch.SUNRAYS_WEIGHT = limit(
      'SUNRAYS_WEIGHT',
      sunrays.step(sunBase * (0.7 + 0.5 * clamp01(f.centroid)), dt)
    );

    sim.setConfigFast(patch);
    return patch;
  }

  return { apply: applyFeel, reset, limits: LIMITS };
}
