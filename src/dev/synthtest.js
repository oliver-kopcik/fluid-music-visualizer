/**
 * Ground-truth tests against synthesised audio. `await window.synthTest()`.
 *
 * Each signal is built with known answers, so these are real assertions rather than
 * judgement calls: the kick at beat k is at exactly k * 60/bpm, the sweep's centroid is a
 * known function of time, the arrangement changes section at exactly 8, 16, 32 and 40
 * seconds. If detection drifts, these fail with a number attached.
 */
import { analyzeTrack } from '../audio/analyze.js';
import { ANALYSIS_SAMPLE_RATE } from '../audio/decode.js';
import { createSpectrogram } from '../audio/spectra.js';
import { createFluidSim } from '../fluid/fluidCore.js';
import { createMapping } from '../mapping/index.js';
import { makeStreams } from '../util/rng.js';
import { pickPreset } from '../presets/index.js';
import * as synth from './synth.js';

async function analyse(mono, name) {
  const { timeline } = await analyzeTrack({ mono, name, sampleRate: ANALYSIS_SAMPLE_RATE });
  return timeline;
}

const band = (tl, id) => {
  const out = [];
  for (let i = 0; i < tl.onsetTimes.length; i++) if (tl.onsetBands[i] === id) out.push(tl.onsetTimes[i]);
  return out;
};

/** Fraction of expected events that have a detection within `tol` seconds. */
function recall(expected, detected, tol = 0.06) {
  let hit = 0;
  for (const e of expected) {
    if (detected.some((d) => Math.abs(d - e) <= tol)) hit++;
  }
  return expected.length ? hit / expected.length : 0;
}

/** Fraction of detections that correspond to a real event — i.e. how many are spurious. */
function precision(expected, detected, tol = 0.06) {
  let hit = 0;
  for (const d of detected) {
    if (expected.some((e) => Math.abs(d - e) <= tol)) hit++;
  }
  return detected.length ? hit / detected.length : 0;
}

/** Median timing error, signed: negative means we fire early. */
function bias(expected, detected, tol = 0.06) {
  const errs = [];
  for (const e of expected) {
    let best = null;
    for (const d of detected) {
      if (Math.abs(d - e) <= tol && (best === null || Math.abs(d - e) < Math.abs(best))) best = d - e;
    }
    if (best !== null) errs.push(best);
  }
  if (!errs.length) return null;
  errs.sort((a, b) => a - b);
  return errs[errs.length >> 1];
}

export async function synthTest({ verbose = true } = {}) {
  const results = [];
  const check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
    if (verbose) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  /**
   * ---- 0. validate the fixtures themselves ------------------------------------------
   *
   * A test signal that isn't what it claims produces confident, wrong conclusions. An
   * earlier version of this file had a "hi-hat" filtered at 306Hz and a "snare" with more
   * energy in the kick band than the snare band, and the resulting failures looked like
   * detector bugs for some time. Check the fixture before trusting it.
   */
  {
    /**
     * Measured as the spectral centroid of the raw buffer.
     *
     * The first attempt compared p95-normalised flux of a hit padded into silence, which
     * is meaningless: almost every frame is zero, so p95 is near zero and the scale
     * explodes — an isolated kick "measured" more high-band flux than low. Centroid needs
     * no normalisation and answers the question directly.
     */
    const centroidOf = (buf) => {
      const spec = createSpectrogram(buf, ANALYSIS_SAMPLE_RATE);
      let num = 0;
      let den = 0;
      for (let f = 0; f < spec.numFrames; f++) {
        const mag = spec.frameAt(f);
        for (let k = 1; k <= 1024; k++) {
          const hz = (k * ANALYSIS_SAMPLE_RATE) / 2048;
          num += hz * mag[k];
          den += mag[k];
        }
      }
      return den > 0 ? num / den : 0;
    };

    const kHz = centroidOf(synth.kick());
    const snHz = centroidOf(synth.snare());
    const htHz = centroidOf(synth.hat(0.8));

    check('fixture: kick is low', kHz < 300, `centroid ${kHz.toFixed(0)} Hz`);
    check('fixture: snare is bright', snHz > 1500, `centroid ${snHz.toFixed(0)} Hz`);
    check('fixture: hat is brightest', htHz > snHz && htHz > 3000, `centroid ${htHz.toFixed(0)} Hz`);
  }

  // ---- 1. four on the floor: onset times and tempo are known exactly ------------------
  {
    const sig = synth.fourOnFloor({ bpm: 120, bars: 10 });
    const tl = await analyse(sig.mono, 'synth-4otf-120');
    const lows = band(tl, 0);

    check(
      '4-on-floor: tempo is 120',
      Math.abs(tl.tempoBPM - 120) < 1.5,
      `got ${tl.tempoBPM.toFixed(1)} BPM, confidence ${tl.tempoConfidence.toFixed(2)}`
    );
    check(
      '4-on-floor: kick recall',
      recall(sig.expectedOnsets, lows) > 0.9,
      `${(recall(sig.expectedOnsets, lows) * 100).toFixed(0)}% of ${sig.expectedOnsets.length} kicks found`
    );
    check(
      '4-on-floor: kick precision',
      precision(sig.expectedOnsets, lows) > 0.9,
      `${(precision(sig.expectedOnsets, lows) * 100).toFixed(0)}% of ${lows.length} detections are real`
    );
    const b = bias(sig.expectedOnsets, lows);
    check(
      '4-on-floor: timing bias under 25ms',
      b !== null && Math.abs(b) < 0.025,
      b === null ? 'no matches' : `${(b * 1000).toFixed(1)}ms`
    );
    check(
      '4-on-floor: beat grid is usable',
      tl.gridUsable && tl.kickCoherence > 0.85,
      `coherence ${tl.kickCoherence.toFixed(3)}`
    );
  }

  // ---- 2. backbeat: kick and snare must land in different bands -----------------------
  {
    const sig = synth.backbeat({ bpm: 128, bars: 8 });
    const tl = await analyse(sig.mono, 'synth-backbeat-128');
    const lows = band(tl, 0);
    const highs = band(tl, 1);

    check(
      'backbeat: tempo is 128',
      Math.abs(tl.tempoBPM - 128) < 2,
      `got ${tl.tempoBPM.toFixed(1)} BPM`
    );
    check(
      'backbeat: kicks found on 1 and 3',
      recall(sig.kicks, lows) > 0.85,
      `${(recall(sig.kicks, lows) * 100).toFixed(0)}% of ${sig.kicks.length}`
    );
    check(
      'backbeat: snares found on 2 and 4',
      recall(sig.snares, highs) > 0.8,
      `${(recall(sig.snares, highs) * 100).toFixed(0)}% of ${sig.snares.length}`
    );
    // The point of band-limited flux: a snare must not be reported as a kick.
    check(
      'backbeat: snares not misread as kicks',
      recall(sig.snares, lows) < 0.3,
      `${(recall(sig.snares, lows) * 100).toFixed(0)}% of snares leaked into the low band`
    );
  }

  /**
   * ---- 2b. pitch: three known sounds must land in the right registers ------------------
   *
   * The backbeat contains exactly three sounds at known times, so the thing the visuals
   * are built from can be scored rather than eyeballed: a kick must measure lower than a
   * snare, which must measure lower than a hat, and each must measure consistently. Get
   * that wrong and every downstream property — height, width, force, colour — is wrong
   * together, which is exactly what used to happen when a kick was clustered as a mid.
   */
  {
    const sig = synth.backbeat({ bpm: 128, bars: 8 });
    const tl = await analyse(sig.mono, 'synth-pitch');
    const { shapeOf } = await import('../mapping/gesture.js');

    const pitchesNear = (times, tol = 0.07) => {
      const out = [];
      for (let i = 0; i < tl.onsetTimes.length; i++) {
        if (times.some((t) => Math.abs(tl.onsetTimes[i] - t) <= tol)) out.push(tl.onsetPitch[i]);
      }
      return out;
    };
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    const spread = (a) => {
      if (a.length < 2) return 0;
      const m = mean(a);
      return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    };

    const offbeat = [];
    for (let b = 0; b < 32; b++) offbeat.push((b + 0.5) * (60 / 128));

    const kp = pitchesNear(sig.kicks);
    const sp = pitchesNear(sig.snares);
    const hp = pitchesNear(offbeat);

    check(
      'pitch: kick reads lower than snare',
      mean(kp) < mean(sp) - 0.15,
      `kick ${mean(kp).toFixed(2)} vs snare ${mean(sp).toFixed(2)}`
    );
    check(
      'pitch: snare reads no higher than the hat',
      mean(sp) <= mean(hp) + 0.05,
      `snare ${mean(sp).toFixed(2)} vs hat ${mean(hp).toFixed(2)}`
    );
    /**
     * Consistency is what makes a recurring sound recognisable: the same drum has to
     * measure the same every bar, or it moves around the frame and changes colour for no
     * audible reason.
     */
    check(
      'pitch: the same sound measures the same each time',
      spread(kp) < 0.12 && spread(sp) < 0.2,
      `kick sd ${spread(kp).toFixed(3)}, snare sd ${spread(sp).toFixed(3)}`
    );
    check(
      'pitch: the full range is used',
      Math.min(...tl.onsetPitch) < 0.1 && Math.max(...tl.onsetPitch) > 0.9,
      `${Math.min(...tl.onsetPitch).toFixed(2)}–${Math.max(...tl.onsetPitch).toFixed(2)}`
    );

    // And the picture must follow: lower sound, lower on screen, wider and heavier.
    const kShape = shapeOf(mean(kp), 0.5);
    const sShape = shapeOf(mean(sp), 0.5);
    check(
      'pitch: low sounds are drawn lower',
      kShape.y < sShape.y - 0.08,
      `kick y=${kShape.y.toFixed(2)} vs snare y=${sShape.y.toFixed(2)}`
    );
    check(
      'pitch: low sounds are drawn wider and heavier',
      kShape.spread > sShape.spread && kShape.weight > sShape.weight,
      `spread ${kShape.spread.toFixed(3)} vs ${sShape.spread.toFixed(3)}`
    );
    /**
     * Smoothness is the property the whole design rests on, so it is asserted directly:
     * no small change in pitch may produce a jump in where a hit is drawn. A bucketed
     * mapping fails this at every boundary.
     */
    let biggestJump = 0;
    let prev = shapeOf(0, 0.5, 0.4);
    for (let i = 1; i <= 200; i++) {
      const cur = shapeOf(i / 200, 0.5, 0.4);
      biggestJump = Math.max(biggestJump, Math.hypot(cur.x - prev.x, cur.y - prev.y));
      prev = cur;
    }
    check('pitch: the mapping is continuous', biggestJump < 0.02, `largest step ${biggestJump.toFixed(4)}`);

    /** The other position axis has to be smooth too, or the frame has a seam in it. */
    let sustainJump = 0;
    let prevS = shapeOf(0.5, 0.5, 0);
    for (let i = 1; i <= 200; i++) {
      const cur = shapeOf(0.5, 0.5, i / 200);
      sustainJump = Math.max(sustainJump, Math.hypot(cur.x - prevS.x, cur.y - prevS.y));
      prevS = cur;
    }
    check('pitch: the sustain axis is continuous', sustainJump < 0.05, `largest step ${sustainJump.toFixed(4)}`);
  }

  /**
   * ---- 2c. envelope: two sounds that differ in nothing else ---------------------------
   *
   * Closed and open hi-hats from the identical noise generator. Pitch, noisiness and level
   * cannot separate them, so if the envelope axis does not, they are drawn the same — the
   * one thing the earlier clustering could do that a three-axis mapping could not.
   */
  {
    const sig = synth.hatPair({ bpm: 120, bars: 8 });
    const tl = await analyse(sig.mono, 'synth-envelope');
    const { shapeOf } = await import('../mapping/gesture.js');

    const near = (times, field, tol = 0.06) => {
      const out = [];
      for (let i = 0; i < tl.onsetTimes.length; i++) {
        if (times.some((t) => Math.abs(tl.onsetTimes[i] - t) <= tol)) out.push(tl[field][i]);
      }
      return out;
    };
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

    const closedDecay = mean(near(sig.closed, 'onsetDecay'));
    const openDecay = mean(near(sig.open, 'onsetDecay'));
    const closedPitch = mean(near(sig.closed, 'onsetPitch'));
    const openPitch = mean(near(sig.open, 'onsetPitch'));

    check(
      'envelope: an open hat is measured as ringing longer than a closed one',
      openDecay > closedDecay + 0.2,
      `closed ${closedDecay.toFixed(2)} vs open ${openDecay.toFixed(2)}`
    );
    /**
     * The point of the axis is that it carries information the others do not, so the pair
     * being close on pitch is part of what is being asserted, not an incidental detail.
     */
    check(
      'envelope: the pair is not separable by pitch',
      Math.abs(openPitch - closedPitch) < 0.3,
      `closed ${closedPitch.toFixed(2)} vs open ${openPitch.toFixed(2)}`
    );
    /**
     * Position is the other half of telling them apart: same pitch means the same height,
     * so if sustain did not move them across the frame they would sit on top of each
     * other and only the tail would distinguish them.
     */
    const closedShape = shapeOf(closedPitch, 0.5, closedDecay);
    const openShape = shapeOf(openPitch, 0.5, openDecay);
    check(
      'envelope: the pair is drawn in different places',
      Math.abs(openShape.x - closedShape.x) > 0.25,
      `closed x=${closedShape.x.toFixed(2)} vs open x=${openShape.x.toFixed(2)}`
    );
  }

  // ---- 3. sweep: the centroid should track a known curve ------------------------------
  {
    const mono = synth.sineSweep(12, 200, 5000);
    const tl = await analyse(mono, 'synth-sweep');
    const at = (frac) => tl.centroidHz[Math.round(frac * (tl.numFrames - 1))];
    const want = (frac) => 200 * Math.pow(5000 / 200, frac);

    const errs = [0.25, 0.5, 0.75].map((f) => Math.abs(at(f) - want(f)) / want(f));
    check(
      'sweep: centroid tracks frequency',
      errs.every((e) => e < 0.25),
      errs.map((e, i) => `${[25, 50, 75][i]}%: ${(e * 100).toFixed(0)}% off`).join(', ')
    );
    check(
      'sweep: centroid rises monotonically',
      at(0.2) < at(0.5) && at(0.5) < at(0.8),
      `${at(0.2).toFixed(0)} < ${at(0.5).toFixed(0)} < ${at(0.8).toFixed(0)} Hz`
    );
  }

  // ---- 4. pad: no percussion at all should read as sparse -----------------------------
  {
    const tl = await analyse(synth.pad(25), 'synth-pad');
    check('pad: detected as sparse', tl.profile === 'sparse', `profile ${tl.profile}, treble ${tl.meanTrebleDb.toFixed(1)}`);
    check(
      'pad: beat grid rejected',
      !tl.gridUsable,
      `coherence ${tl.kickCoherence.toFixed(3)}, confidence ${tl.tempoConfidence.toFixed(2)}`
    );
    let maxSustain = 0;
    for (const v of tl.sustain) if (v > maxSustain) maxSustain = v;
    check('pad: sustain term is alive', maxSustain > 0.3, `max sustain ${maxSustain.toFixed(2)}`);
  }

  // ---- 5. silence: must not produce NaN or a frozen screen ----------------------------
  {
    const tl = await analyse(synth.silence(12), 'synth-silence');
    let bad = null;
    for (const [k, v] of Object.entries(tl)) {
      if (!ArrayBuffer.isView(v) || v instanceof Int32Array || v instanceof Uint8Array) continue;
      for (let i = 0; i < v.length; i += 13) if (!Number.isFinite(v[i])) bad = k;
    }
    check('silence: no NaN in analysis', !bad, bad ? `bad field ${bad}` : '');
    check('silence: no phantom onsets', tl.onsetTimes.length < 5, `${tl.onsetTimes.length} onsets`);

    // The idle bed exists so silence reads as calm rather than frozen.
    const st = makeStreams(3);
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 72;
    let splats = 0;
    const sim = createFluidSim(c, { rng: st.rngSim, initialSplats: 0, onSplat: () => splats++ });
    await sim.ready;
    sim.setSize(128, 72);
    sim.clear();
    const m = createMapping({ timeline: tl, preset: pickPreset(tl), rng: st.rngMap });
    m.reset(2);
    for (let f = 0; f < 300; f++) {
      m.applyFrame(sim, { live: null }, 2 + f / 60, 1 / 60);
      sim.step(1 / 60);
      sim.render(null);
    }
    sim.dispose();
    check('silence: still moves (idle bed)', splats > 50, `${splats} splats over 5s`);
    check('silence: but stays restrained', splats < 2500, `${splats} splats over 5s`);
  }

  // ---- 6. structured arrangement: sections, anticipation, release ---------------------
  {
    const sig = synth.structured({ bpm: 128 });
    const tl = await analyse(sig.mono, 'synth-structured');

    const bounds = Array.from(tl.sectionBounds);
    const found = sig.expectedBoundaries.filter((e) => bounds.some((b) => Math.abs(b - e) <= 3));
    check(
      'structured: finds the arrangement boundaries',
      found.length >= 3,
      `${found.length}/4 within 3s — got [${bounds.map((b) => b.toFixed(0)).join(', ')}], wanted [8, 16, 32, 40]`
    );

    // Imminence must peak *before* a drop, which is the whole point of the lookahead.
    const val = (arr, t) => arr[Math.min(tl.numFrames - 1, Math.round(t * tl.frameRate))];
    for (const drop of sig.expectedDrops) {
      const before = Math.max(val(tl.imminence, drop - 2), val(tl.imminence, drop - 1.2));
      const after = val(tl.imminence, drop + 3);
      check(
        `structured: anticipates the drop at ${drop}s`,
        before > 0.35 && before > after,
        `imminence ${before.toFixed(2)} before vs ${after.toFixed(2)} after`
      );
    }

    for (const drop of sig.expectedDrops) {
      const peak = Math.max(val(tl.release, drop), val(tl.release, drop + 0.6), val(tl.release, drop + 1.2));
      check(`structured: release fires at ${drop}s`, peak > 0.5, `release ${peak.toFixed(2)}`);
    }

    // And the arc must actually act on it.
    const st = makeStreams(5);
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 72;
    const sim = createFluidSim(c, { rng: st.rngSim, initialSplats: 0 });
    await sim.ready;
    sim.setSize(128, 72);
    sim.clear();
    const m = createMapping({ timeline: tl, preset: pickPreset(tl), rng: st.rngMap });
    m.reset(0);

    const trace = [];
    for (let f = 0; f < Math.round(sig.duration * 60); f++) {
      const t = f / 60;
      m.applyFrame(sim, { live: null }, t, 1 / 60);
      sim.step(1 / 60);
      sim.render(null);
      trace.push({ t, coil: m.arc.coil, burst: m.arc.burst, intensity: m.arc.intensity, atmos: m.arc.atmosphereName });
    }
    sim.dispose();

    const near = (t, w = 1.2) => trace.filter((s) => Math.abs(s.t - t) < w);
    const maxOf = (rows, key) => rows.reduce((m, r) => Math.max(m, r[key]), 0);

    const coilBefore = maxOf(near(14.5, 1.5), 'coil');
    const burstAfter = maxOf(near(17.5, 2), 'burst');
    check(
      'structured: arc coils before the drop',
      coilBefore > 0.3,
      `peak coil ${coilBefore.toFixed(2)} in 13-16s`
    );
    check(
      'structured: arc bursts on the drop',
      burstAfter > 0.4,
      `peak burst ${burstAfter.toFixed(2)} in 15.5-19.5s`
    );

    const quietIntensity = maxOf(near(5, 3), 'intensity');
    const dropIntensity = maxOf(near(24, 4), 'intensity');
    check(
      'structured: dynamic range between quiet and drop',
      dropIntensity > quietIntensity * 1.6,
      `intensity ${quietIntensity.toFixed(2)} quiet vs ${dropIntensity.toFixed(2)} drop`
    );

    const atmos = new Set(trace.map((s) => s.atmos));
    check('structured: atmosphere changes across sections', atmos.size >= 3, [...atmos].join(', '));
  }

  const failed = results.filter((r) => !r.pass);
  const summary = `${results.length - failed.length}/${results.length} passed`;
  if (verbose) console.log(`\n${failed.length ? 'FAILURES: ' + failed.map((f) => f.name).join('; ') : 'all passed'} (${summary})`);
  return { summary, failed: failed.map((f) => ({ name: f.name, detail: f.detail })), results };
}
