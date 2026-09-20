/**
 * The arc: what the visual is *doing* right now, as opposed to how loud the audio is.
 *
 * This is the layer that was missing. Everything else reacts to the current frame; this
 * one reads the structural curves — section, tension, imminence, release — and decides on
 * a posture. A build coils. A drop bursts. A breakdown drifts and goes dark. The music
 * changes what happens, not just how much of it happens.
 *
 * It also owns dynamic range. Six emitters firing flat out forever leaves a hit nothing
 * to land against, so quiet sections are allowed to be genuinely quiet — few emitters,
 * little dye, a nearly dark screen — which is what makes the loud parts land.
 */
import { OnePole, Envelope, clamp01, lerp } from './smoothers.js';
import { blendFormations } from './emitters.js';

export const POSTURES = ['drift', 'ring', 'coil', 'burst'];

export function createArc() {
  // Postures cross-fade rather than switch, or every boundary would be a visual glitch.
  const wDrift = new OnePole(0.7, 0.25);
  const wRing = new OnePole(0.7, 0.75);
  const wCoil = new OnePole(0.45, 0);
  const wBurst = new Envelope(0.08, 1.1, 0);

  const intensity = new OnePole(0.5, 0.5);
  const sectionHue = new OnePole(1.2, 0.5);

  const weights = { drift: 0, ring: 0, coil: 0, burst: 0 };
  const formation = {};

  const state = {
    posture: 'ring',
    weights,
    formation,
    /** 0..1 overall level of activity — the dynamic-range control. */
    intensity: 0.5,
    /** 0..1, how coiled. Drives curl and inward pull. */
    coil: 0,
    /** 0..1, spends down after a drop lands. */
    burst: 0,
    /** Hue offset for the current section, so colour changes at boundaries. */
    hueOffset: 0,
    sectionIndex: -1,
    sectionKind: 'mid',
    justChangedSection: false
  };

  let lastSection = -1;

  function reset() {
    wDrift.reset(0.25);
    wRing.reset(0.75);
    wCoil.reset(0);
    wBurst.reset(0);
    intensity.reset(0.5);
    sectionHue.reset(0.5);
    lastSection = -1;
    state.sectionIndex = -1;
  }

  /**
   * @param s.kind       'quiet' | 'mid' | 'high'
   * @param s.tension    0..1 climbing
   * @param s.imminence  0..1 something big is close
   * @param s.release    0..1 something big just landed
   */
  function update(s, dt) {
    const { kind, tension, imminence, release, energy, sectionIndex } = s;

    state.justChangedSection = sectionIndex !== lastSection;
    if (state.justChangedSection) {
      lastSection = sectionIndex;
      state.sectionIndex = sectionIndex;
      state.sectionKind = kind;
    }

    // Coil is the anticipation term: imminence dominates, tension supports it. This is
    // what makes the picture tighten *before* the drop rather than after.
    const coilTarget = clamp01(imminence * 0.85 + tension * 0.4);
    const burstTarget = clamp01(release);

    // Postures compete. Burst overrides everything; coil overrides the resting ring;
    // quiet sections fall back to drift.
    const quietness = kind === 'quiet' ? 1 : kind === 'mid' ? 0.25 : 0;
    const rawBurst = wBurst.step(burstTarget, dt);
    const rawCoil = wCoil.step(coilTarget * (1 - rawBurst), dt);
    const rawDrift = wDrift.step(quietness * (1 - rawBurst) * (1 - rawCoil * 0.7), dt);
    const rawRing = wRing.step(1 - quietness * 0.8, dt) * (1 - rawBurst) * (1 - rawCoil * 0.6);

    weights.drift = rawDrift;
    weights.ring = rawRing;
    weights.coil = rawCoil;
    weights.burst = rawBurst;
    blendFormations(weights, formation);

    state.coil = rawCoil;
    state.burst = rawBurst;
    state.posture =
      rawBurst > 0.4 ? 'burst' : rawCoil > 0.45 ? 'coil' : rawDrift > rawRing ? 'drift' : 'ring';

    /**
     * Dynamic range. A quiet section runs at a fraction of full output — and because the
     * floor is low, the jump into a high section is a real event. During a coil the
     * output is *pulled down* as well as inward, so the release has somewhere to go.
     */
    const base = kind === 'high' ? 1 : kind === 'mid' ? 0.6 : 0.22;
    const target = clamp01(base * lerp(1, 0.55, rawCoil) * (0.65 + 0.5 * energy) + rawBurst * 0.55);
    state.intensity = intensity.step(target, dt);

    // Hue walks by a fixed irrational step per section, so consecutive sections are always
    // well separated and a track never repeats the same colour twice in a row.
    const hueTarget = (sectionIndex * 0.381966) % 1;
    state.hueOffset = sectionHue.step(hueTarget, dt);

    return state;
  }

  return { update, reset, state };
}
