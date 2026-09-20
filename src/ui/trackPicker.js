/**
 * Loading a track: drag-drop, a file picker, and a quick-pick of whatever is in music/.
 *
 * music/ is gitignored, so this list is whatever you personally dropped there. The glob is
 * resolved at build time, which means a newly added file needs a dev-server restart — the
 * empty state says so rather than leaving you wondering.
 */

const localTracks = import.meta.glob('/music/*.{mp3,wav,flac,m4a,ogg,opus}', {
  query: '?url',
  import: 'default'
});

export function createTrackPicker(container, { onLoad }) {
  const root = document.createElement('div');
  root.className = 'picker';
  root.innerHTML = `
    <div class="picker-inner">
      <h1>Fluid Music Visualizer</h1>
      <p class="hint">Drop an audio file anywhere, or pick one below.</p>
      <div class="tracks"></div>
      <button class="browse">Choose a file…</button>
      <p class="status"></p>
    </div>`;
  container.appendChild(root);

  const tracksEl = root.querySelector('.tracks');
  const statusEl = root.querySelector('.status');
  const browseEl = root.querySelector('.browse');

  const names = Object.keys(localTracks);
  if (names.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint dim';
    empty.textContent = 'Put audio in music/ and restart the dev server to list it here.';
    tracksEl.appendChild(empty);
  } else {
    for (const path of names) {
      const button = document.createElement('button');
      button.className = 'track';
      button.textContent = decodeURIComponent(path.replace('/music/', ''));
      // Resolving the glob happens inside load()'s try, so a failure here surfaces in the
      // panel instead of becoming an unhandled rejection.
      button.onclick = () => load(() => localTracks[path](), button.textContent);
      tracksEl.appendChild(button);
    }
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.style.display = 'none';
  input.onchange = () => {
    if (input.files?.[0]) load(input.files[0], input.files[0].name);
  };
  root.appendChild(input);
  browseEl.onclick = () => input.click();

  async function load(source, name) {
    setStatus('Decoding…');
    try {
      const fileOrUrl = typeof source === 'function' ? await source() : source;
      await onLoad(fileOrUrl, name, setStatus);
      hide();
    } catch (err) {
      console.error('track load failed', err);
      setStatus(`Could not load: ${err.message}`, true);
    }
  }

  function setStatus(text, isError = false) {
    statusEl.textContent = text ?? '';
    statusEl.classList.toggle('error', isError);
  }

  function hide() {
    root.classList.add('hidden');
  }
  function show() {
    root.classList.remove('hidden');
    setStatus('');
  }

  // Drag-drop on the whole window, not just the panel.
  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    window.addEventListener(type, prevent);
  }
  window.addEventListener('dragenter', () => root.classList.add('dropping'));
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) root.classList.remove('dropping');
  });
  window.addEventListener('drop', (e) => {
    root.classList.remove('dropping');
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      show();
      load(file, file.name);
    }
  });

  return { show, hide, setStatus };
}
