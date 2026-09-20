/**
 * Presets are the thing you actually iterate on. Everything in the mapping layer has a
 * default; these just say how a particular kind of material should be treated.
 *
 * `auto` picks from the analysed profile, which is a heuristic on a continuous quantity —
 * so a preset can always be chosen by hand instead.
 */

/**
 * Dissipation runs far higher than upstream's default of 1.
 *
 * Upstream splats only on mouse movement, so dye is sparse and a slow fade looks like
 * lingering smoke. A dozen readers at 60Hz inject continuously, and at a dissipation of ~1
 * the dye reaches the screen edges and stays there — the picture turns into a flat wash
 * within a couple of seconds. Swept live against the EDM track, the dark-background look
 * with vivid structure appears around 6-7. Louder passages still fade slower than quiet
 * ones, just within a much narrower band.
 */
const base = {
  /**
   * One layer now, so one force. `flow` and `hits` used to be tuned separately, at 220 for
   * the ambient layer and 2400 for impulses; the field draws both from the same measured
   * rise, so a single impulse-scale force covers it. `readers` is how finely the frequency
   * axis is sampled.
   */
  field: { readers: 12, force: 2400 },
  feel: {
    ranges: { curlMin: 18, curlMax: 48, radiusMin: 0.18, radiusMax: 0.34, densityQuiet: 7.5, densityLoud: 5.0, bloomBase: 0.29 }
  },
  color: { palette: 'auto' },
  sim: { DYE_RESOLUTION: 1024, SIM_RESOLUTION: 128, COLORFUL: false, SHADING: true, BLOOM: true, SUNRAYS: true }
};

function merge(name, label, patch) {
  return {
    name,
    label,
    field: { ...base.field, ...patch.field },
    feel: { ranges: { ...base.feel.ranges, ...(patch.feel?.ranges ?? {}) } },
    color: { ...base.color, ...patch.color },
    sim: { ...base.sim, ...patch.sim }
  };
}

export const PRESETS = {
  edm: merge('edm', 'EDM / club', {
    field: { readers: 14, force: 2600 },
    feel: { ranges: { curlMax: 52, densityLoud: 4.5, bloomBase: 0.29 } },
    color: { palette: 'auto' }
  }),

  // Nothing percussive to compete with, so every rise is gentler and a lighter touch keeps
  // the picture from being driven harder than the material warrants.
  lead: merge('lead', 'Drumless / lead', {
    field: { readers: 12, force: 1500 },
    feel: { ranges: { curlMin: 14, curlMax: 38, densityQuiet: 8.5, densityLoud: 6.0, bloomBase: 0.23 } },
    color: { palette: 'auto' }
  }),

  ambient: merge('ambient', 'Ambient / slow', {
    field: { readers: 10, force: 1100 },
    feel: { ranges: { curlMin: 10, curlMax: 28, densityQuiet: 9.0, densityLoud: 7.0, bloomBase: 0.2 } },
    color: { palette: 'auto' }
  }),

  pop: merge('pop', 'Pop / mixed', {
    field: { readers: 12, force: 2200 },
    color: { palette: 'auto' }
  })
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Best guess from the analysis; always overridable in the UI. */
export function pickPreset(timeline) {
  if (timeline.profile === 'sparse') return PRESETS.lead;
  if (timeline.gridUsable && timeline.tempoBPM >= 118) return PRESETS.edm;
  return PRESETS.pop;
}
