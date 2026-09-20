/**
 * Scrolling view of what the analyser thinks is happening.
 *
 * Everything downstream — every splat, every parameter sweep — is built on onset
 * detection being right. Tuning delta and the window sizes by watching the fluid and
 * guessing is hopeless; watching the flux curve cross its threshold while you listen
 * tells you immediately whether a missed kick is a detection problem or a mapping one.
 *
 * Toggle with D.
 */

const WINDOW_SECONDS = 6;
const ROW_HEIGHT = 54;

const ROWS = [
  { field: 'fluxLow', threshold: 'thresholdLow', label: 'flux low (kick)', color: '#ff5e7a', band: 'low' },
  { field: 'fluxHigh', threshold: 'thresholdHigh', label: 'flux high (snare)', color: '#5ec8ff', band: 'high' },
  { field: 'flux', threshold: 'thresholdFull', label: 'flux full', color: '#c8a2ff', band: 'full' }
];

const BANDS = [
  { field: 'bass', color: '#ff7a3d' },
  { field: 'mid', color: '#6ee36e' },
  { field: 'treble', color: '#7ad4ff' },
  { field: 'sustain', color: '#ffd166' }
];

export function createDebugOverlay(container) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;width:100%;height:' +
    (ROWS.length + 1) * ROW_HEIGHT +
    'px;pointer-events:none;display:none;z-index:5';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let visible = false;
  const spectrum = new Float32Array(32);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  function draw(timeline, t) {
    if (!visible || !timeline) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, w, h);

    const t0 = t - WINDOW_SECONDS * 0.7;
    const t1 = t + WINDOW_SECONDS * 0.3;
    const xOf = (time) => ((time - t0) / (t1 - t0)) * w;

    ROWS.forEach((row, i) => {
      const top = i * ROW_HEIGHT;
      drawCurveRow(ctx, timeline, row, t0, t1, xOf, top, w);
    });

    drawBandRow(ctx, timeline, t0, t1, xOf, ROWS.length * ROW_HEIGHT, w);

    // Beat grid across everything, so you can see whether hits land on it.
    if (timeline.gridUsable) {
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 1;
      for (const b of timeline.beats) {
        if (b < t0 || b > t1) continue;
        ctx.beginPath();
        ctx.moveTo(xOf(b), 0);
        ctx.lineTo(xOf(b), h);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      for (const b of timeline.downbeats) {
        if (b < t0 || b > t1) continue;
        ctx.beginPath();
        ctx.moveTo(xOf(b), 0);
        ctx.lineTo(xOf(b), h);
        ctx.stroke();
      }
    }

    // Playhead.
    const px = xOf(t);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();

    timeline.spectrumAt(t, spectrum);
    drawSpectrum(ctx, spectrum, w - 150, 6, 140, 30);

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const grid = timeline.gridUsable
      ? `${timeline.tempoBPM.toFixed(1)} BPM (conf ${timeline.tempoConfidence.toFixed(2)})`
      : `no grid (conf ${timeline.tempoConfidence.toFixed(2)})`;
    ctx.fillText(`${t.toFixed(2)}s  ${grid}  profile: ${timeline.profile}`, 8, h - 6);
  }

  function drawCurveRow(ctx, timeline, row, t0, t1, xOf, top, w) {
    const values = timeline[row.field];
    const thresh = timeline[row.threshold];
    const baseline = top + ROW_HEIGHT - 10;
    const scale = ROW_HEIGHT - 18;

    const f0 = Math.max(0, Math.floor(t0 * timeline.frameRate));
    const f1 = Math.min(timeline.numFrames - 1, Math.ceil(t1 * timeline.frameRate));

    const plot = (arr, style, width) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let f = f0; f <= f1; f++) {
        const x = xOf(f / timeline.frameRate);
        const y = baseline - Math.min(1.6, arr[f]) * scale * 0.62;
        f === f0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    plot(thresh, 'rgba(255,255,255,0.45)', 1);
    plot(values, row.color, 1.4);

    // Onset ticks, height by strength — the thing you actually check against your ears.
    ctx.fillStyle = row.color;
    for (let i = 0; i < timeline.onsetTimes.length; i++) {
      const ot = timeline.onsetTimes[i];
      if (ot < t0 || ot > t1) continue;
      const band = ['low', 'high', 'full'][timeline.onsetBands[i]];
      if (band !== row.band) continue;
      const x = xOf(ot);
      const hgt = 6 + timeline.onsetStrengths[i] * 16;
      ctx.fillRect(x - 1, baseline - hgt, 2, hgt);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(row.label, 8, top + 12);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(w, top);
    ctx.stroke();
  }

  function drawBandRow(ctx, timeline, t0, t1, xOf, top, w) {
    const baseline = top + ROW_HEIGHT - 10;
    const scale = ROW_HEIGHT - 18;
    const f0 = Math.max(0, Math.floor(t0 * timeline.frameRate));
    const f1 = Math.min(timeline.numFrames - 1, Math.ceil(t1 * timeline.frameRate));

    for (const band of BANDS) {
      const arr = timeline[band.field];
      if (!arr) continue;
      ctx.strokeStyle = band.color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let f = f0; f <= f1; f++) {
        const x = xOf(f / timeline.frameRate);
        const y = baseline - Math.min(1.6, arr[f]) * scale * 0.6;
        f === f0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    let x = 8;
    for (const band of BANDS) {
      ctx.fillStyle = band.color;
      ctx.fillText(band.field, x, top + 12);
      x += ctx.measureText(band.field).width + 12;
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(w, top);
    ctx.stroke();
  }

  function drawSpectrum(ctx, values, x, y, w, h) {
    const bw = w / values.length;
    for (let i = 0; i < values.length; i++) {
      const v = Math.min(1, values[i]);
      ctx.fillStyle = `hsl(${200 + i * 4} 80% ${35 + v * 40}%)`;
      ctx.fillRect(x + i * bw, y + h - v * h, Math.max(1, bw - 1), v * h);
    }
  }

  return {
    draw,
    get visible() {
      return visible;
    },
    toggle() {
      visible = !visible;
      canvas.style.display = visible ? 'block' : 'none';
      if (visible) resize();
      return visible;
    }
  };
}
