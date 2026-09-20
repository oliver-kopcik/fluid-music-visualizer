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
 * lingering smoke. Six emitters at 60Hz inject continuously, and at a dissipation of ~1
 * the dye reaches the screen edges and stays there — the picture turns into a flat wash
 * within a couple of seconds. Swept live against the EDM track, the dark-background look
 * with vivid structure appears around 6-7. Louder passages still fade slower than quiet
 * ones, just within a much narrower band.
 */
const base = {
  flow: { emitters: 6, force: 220, gate: 0.06, steer: 0.9, sustainDrive: 0.6, curtain: false },
  hits: { force: 2400 },
  feel: {
    ranges: { curlMin: 18, curlMax: 48, radiusMin: 0.18, radiusMax: 0.34, densityQuiet: 7.5, densityLoud: 5.0, bloomBase: 0.5 }
  },
  color: { palette: 'spectral' },
  sim: { DYE_RESOLUTION: 1024, SIM_RESOLUTION: 128, COLORFUL: false, SHADING: true, BLOOM: true, SUNRAYS: true }
};

function merge(name, label, patch) {
  return {
    name,
    label,
    flow: { ...base.flow, ...patch.flow },
    hits: { ...base.hits, ...patch.hits },
    feel: { ranges: { ...base.feel.ranges, ...(patch.feel?.ranges ?? {}) } },
    color: { ...base.color, ...patch.color },
    sim: { ...base.sim, ...patch.sim }
  };
}

export const PRESETS = {
  edm: merge('edm', 'EDM / club', {
    flow: { force: 240, curtain: true },
    hits: { force: 2600 },
    feel: { ranges: { curlMax: 52, densityLoud: 4.5, bloomBase: 0.5 } },
    color: { palette: 'neon' }
  }),

  // Nothing percussive to compete with, so hits are gentler and the sustained terms do
  // more of the work. Steering is turned up because melodic motion is the main signal.
  lead: merge('lead', 'Drumless / lead', {
    flow: { force: 260, steer: 1.2, sustainDrive: 1.0, curtain: false },
    hits: { force: 1400 },
    feel: { ranges: { curlMin: 14, curlMax: 38, densityQuiet: 8.5, densityLoud: 6.0, bloomBase: 0.4 } },
    color: { palette: 'ice' }
  }),

  ambient: merge('ambient', 'Ambient / slow', {
    flow: { force: 150, steer: 0.7, sustainDrive: 1.2, curtain: false },
    hits: { force: 1000 },
    feel: { ranges: { curlMin: 10, curlMax: 28, densityQuiet: 9.0, densityLoud: 7.0, bloomBase: 0.35 } },
    color: { palette: 'sunset' }
  }),

  pop: merge('pop', 'Pop / mixed', {
    flow: { force: 210 },
    hits: { force: 2200 },
    color: { palette: 'spectral' }
  })
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Best guess from the analysis; always overridable in the UI. */
export function pickPreset(timeline) {
  if (timeline.profile === 'sparse') return PRESETS.lead;
  if (timeline.gridUsable && timeline.tempoBPM >= 118) return PRESETS.edm;
  return PRESETS.pop;
}
