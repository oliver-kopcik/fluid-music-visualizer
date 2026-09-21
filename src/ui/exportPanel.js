/**
 * Export UI.
 *
 * Two paths, deliberately labelled by what they actually guarantee rather than by
 * technology. "Record" is realtime and can drop frames; "Render" is frame-accurate and
 * slower than realtime. Presenting them as equivalent options with different file formats
 * would hide the only difference that matters.
 */
import { RESOLUTIONS, renderToFile, renderSidecar } from '../export/offlineLoop.js';
import { startQuickRecord, canQuickRecord } from '../export/mediaRecorder.js';
import { hasWebCodecs } from '../export/webcodecsEncoder.js';
import { canStreamToDisk } from '../export/fileSink.js';

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

const safeName = (name) => (name || 'fluid').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').slice(0, 60);

export function createExportPanel(container, { canvas, player, getState }) {
  const root = document.createElement('div');
  root.className = 'exportp hidden';
  root.innerHTML = `
    <div class="ep-inner">
      <div class="ep-head">
        <h2>Export</h2>
        <button class="ep-close" title="Close (Esc)">×</button>
      </div>

      <section class="ep-card">
        <h3>Render <span class="ep-tag ep-good">frame-accurate</span></h3>
        <p>Steps the simulation at a fixed rate, so every frame is present and the result is
           reproducible. Slower than realtime.</p>
        <div class="ep-grid">
          <label>resolution
            <select class="ep-res">
              <option value="720p">720p</option>
              <option value="1080p" selected>1080p</option>
              <option value="1440p">1440p</option>
            </select>
          </label>
          <label>fps
            <select class="ep-fps"><option>30</option><option selected>60</option></select>
          </label>
          <label>quality
            <select class="ep-bitrate">
              <option value="16">high</option>
              <option value="10" selected>very high</option>
              <option value="6">maximum</option>
            </select>
          </label>
          <label>range
            <select class="ep-range">
              <option value="all" selected>whole track</option>
              <option value="30">30s from here</option>
              <option value="60">60s from here</option>
            </select>
          </label>
        </div>
        <div class="ep-actions">
          <button class="ep-btn ep-primary ep-render">Render to MP4</button>
          <button class="ep-btn ep-cancel" hidden>Cancel</button>
        </div>
        <div class="ep-progress" hidden>
          <div class="ep-bar"><div class="ep-fill"></div></div>
          <p class="ep-status"></p>
        </div>
      </section>

      <section class="ep-card">
        <h3>Record <span class="ep-tag ep-warn">realtime, may drop frames</span></h3>
        <p>Captures the window exactly as you see it, with sound. Good for a quick clip;
           any stutter is baked into the file.</p>
        <div class="ep-actions">
          <button class="ep-btn ep-rec">Start recording</button>
          <span class="ep-rec-status"></span>
        </div>
      </section>

      <p class="ep-note"></p>
    </div>`;
  container.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const renderBtn = $('.ep-render');
  const cancelBtn = $('.ep-cancel');
  const recBtn = $('.ep-rec');
  const recStatus = $('.ep-rec-status');
  const progress = $('.ep-progress');
  const fill = $('.ep-fill');
  const status = $('.ep-status');
  const note = $('.ep-note');

  const caveats = [];
  if (!hasWebCodecs()) caveats.push('WebCodecs is unavailable, so frame-accurate rendering is disabled.');
  if (!canStreamToDisk()) caveats.push('This browser cannot stream to disk, so long renders are limited by memory.');
  if (!canQuickRecord()) caveats.push('Canvas recording is unavailable.');
  note.textContent = caveats.join(' ');
  renderBtn.disabled = !hasWebCodecs();
  recBtn.disabled = !canQuickRecord();

  // --- render ------------------------------------------------------------------------
  let controller = null;
  renderBtn.onclick = async () => {
    const state = getState();
    if (!state.timeline) {
      status.textContent = 'Load a track first.';
      progress.hidden = false;
      return;
    }

    const rangeVal = $('.ep-range').value;
    const startTime = rangeVal === 'all' ? 0 : player.currentTime;
    const duration = rangeVal === 'all' ? null : Number(rangeVal);

    controller = new AbortController();
    renderBtn.disabled = true;
    cancelBtn.hidden = false;
    progress.hidden = false;
    fill.style.width = '0%';
    status.textContent = 'Preparing…';

    try {
      const result = await renderToFile({
        timeline: state.timeline,
        audioBuffer: player.buffer,
        seed: state.seed,
        resolution: $('.ep-res').value,
        fps: Number($('.ep-fps').value),
        quantizer: Number($('.ep-bitrate').value),
        startTime,
        duration,
        filename: `${safeName(state.trackName)}.mp4`,
        signal: controller.signal,
        onProgress: (p) => {
          fill.style.width = `${Math.round(p.progress * 100)}%`;
          if (p.phase === 'audio') status.textContent = 'Encoding audio…';
          else if (p.phase === 'finalizing') status.textContent = 'Finalizing…';
          else {
            status.textContent =
              `${Math.round(p.progress * 100)}% · frame ${p.frame}/${p.totalFrames}` +
              (p.fps ? ` · ${p.fps.toFixed(0)} fps · ${fmtTime(p.etaSeconds)} left` : '');
          }
        }
      });

      if (result.cancelled) {
        status.textContent = result.contextLost
          ? 'Cancelled — the GPU context was lost. Try a lower resolution.'
          : 'Cancelled.';
      } else {
        const sidecar = renderSidecar({ ...state, result });
        console.log('render complete', sidecar);
        status.textContent =
          `Done — ${result.frames} frames, ${result.width}×${result.height}, ${result.codec}` +
          `${result.hasAudio ? ' with audio' : ', no audio'} in ${fmtTime(result.seconds)}.`;
        fill.style.width = '100%';
      }
    } catch (err) {
      console.error(err);
      status.textContent = `Failed: ${err.message}`;
    } finally {
      renderBtn.disabled = !hasWebCodecs();
      cancelBtn.hidden = true;
      controller = null;
    }
  };

  cancelBtn.onclick = () => controller?.abort();

  // --- quick record -------------------------------------------------------------------
  let recorder = null;
  let recTimer = null;
  recBtn.onclick = async () => {
    if (recorder) {
      const state = getState();
      recBtn.disabled = true;
      recStatus.textContent = 'Saving…';
      const out = await recorder.stop(`${safeName(state.trackName)}-clip`);
      recorder = null;
      clearInterval(recTimer);
      recBtn.textContent = 'Start recording';
      recBtn.disabled = false;
      recBtn.classList.remove('ep-recording');
      recStatus.textContent = `Saved ${(out.bytes / 1e6).toFixed(1)} MB`;
      return;
    }
    try {
      recorder = startQuickRecord({ canvas, player, fps: 60 });
      recBtn.textContent = 'Stop & save';
      recBtn.classList.add('ep-recording');
      hide();
      recTimer = setInterval(() => {
        recStatus.textContent = `● ${fmtTime(recorder.elapsed)}`;
      }, 500);
    } catch (err) {
      recStatus.textContent = err.message;
    }
  };

  function show() {
    root.classList.remove('hidden');
  }
  function hide() {
    root.classList.add('hidden');
  }
  $('.ep-close').onclick = hide;
  root.addEventListener('click', (e) => e.target === root && hide());

  return { show, hide, toggle: () => root.classList.toggle('hidden'), get recording() { return !!recorder; } };
}
