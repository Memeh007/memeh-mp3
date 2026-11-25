'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const playlistInput = document.getElementById('playlist');
const previewBtn = document.getElementById('previewBtn');
const convertBtn = document.getElementById('convertBtn');
const cancelBtn = document.getElementById('cancelBtn');
const alertEl = document.getElementById('alert');
const toolsEl = document.getElementById('tools');
const previewEl = document.getElementById('preview');
const thumbEl = document.getElementById('thumb');
const kindEl = document.getElementById('kind');
const titleEl = document.getElementById('title');
const subEl = document.getElementById('sub');
const progressWrap = document.getElementById('progressWrap');
const progressLabel = document.getElementById('progressLabel');
const progressPct = document.getElementById('progressPct');
const progressSub = document.getElementById('progressSub');
const barFill = document.getElementById('barFill');
const pipetteFill = document.getElementById('pipetteFill');
const resultEl = document.getElementById('result');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const setupEl = document.getElementById('setup');
const setupTitle = document.getElementById('setupTitle');
const setupText = document.getElementById('setupText');
const setupFill = document.getElementById('setupFill');
const setupRetry = document.getElementById('setupRetry');
const outDirEl = document.getElementById('outDir');
const changeDirBtn = document.getElementById('changeDir');
const openDirBtn = document.getElementById('openDir');

let currentPreview = null;
let busy = false;
let toolsReady = false;

function fx() {
  return window.MemehFX || {
    setConverting() {},
    setPulse() {},
    blip() {},
    ensureAudio() {},
  };
}

function errText(err, fallback) {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  return err.message || fallback;
}

function selectedFormat() {
  const chosen = form.querySelector('input[name="format"]:checked');
  return chosen ? chosen.value : 'mp3';
}

function selectedQuality() {
  const chosen = form.querySelector('input[name="quality"]:checked');
  return Number(chosen ? chosen.value : 192);
}

function selectedResolution() {
  const chosen = form.querySelector('input[name="resolution"]:checked');
  return chosen ? chosen.value : '720';
}

function fileLabel(file) {
  if (file.label) return file.label;
  return file.format === 'mp4' ? 'MP4' : 'MP3';
}

function syncFormatUi() {
  const format = selectedFormat();
  const audio = document.getElementById('audioQuality');
  const video = document.getElementById('videoQuality');
  if (audio) audio.hidden = format !== 'mp3';
  if (video) video.hidden = format !== 'mp4';
  if (convertBtn) convertBtn.textContent = format === 'mp4' ? 'Extract MP4' : 'Extract MP3';
}

function showAlert(message) {
  if (!message) {
    alertEl.hidden = true;
    alertEl.textContent = '';
    return;
  }
  alertEl.hidden = false;
  alertEl.textContent = message;
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function button(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

async function openFile(path) {
  try {
    await invoke('open_file', { path });
  } catch (err) {
    showAlert(errText(err, 'Could not open that file.'));
  }
}

async function revealFile(path) {
  try {
    await invoke('reveal_file', { path });
  } catch (err) {
    showAlert(errText(err, 'Could not open the folder.'));
  }
}

// ---------- first run setup ----------

function updateLocks() {
  previewBtn.disabled = busy || !toolsReady;
  convertBtn.disabled = busy || !currentPreview || !toolsReady;
}

async function runSetup() {
  setupEl.hidden = false;
  setupEl.classList.remove('error');
  setupRetry.hidden = true;
  setupTitle.textContent = 'FIRST RUN SETUP';
  setupText.textContent = 'Grabbing the YouTube engine. This only happens once.';
  setupFill.style.width = '2%';
  try {
    const status = await invoke('setup_tools');
    toolsReady = Boolean(status && status.ready);
    if (toolsReady) {
      setupTitle.textContent = 'READY';
      setupText.textContent = 'All set. Paste a link to get started.';
      setupFill.style.width = '100%';
      fx().blip('done');
      setTimeout(() => {
        setupEl.hidden = true;
      }, 1600);
    } else {
      throw new Error('Some parts are still missing.');
    }
  } catch (err) {
    setupEl.classList.add('error');
    setupTitle.textContent = 'SETUP HIT A SNAG';
    setupText.textContent = `${errText(err, 'Setup failed.')} Check your internet and try again.`;
    setupRetry.hidden = false;
    fx().blip('error');
  }
  updateLocks();
}

listen('setup', (event) => {
  const p = event.payload || {};
  if (p.done) return;
  const steps = p.steps || 1;
  const step = p.step || 1;
  const part = typeof p.percent === 'number' ? p.percent : 0;
  const overall = ((step - 1) + part / 100) / steps * 100;
  setupFill.style.width = `${Math.max(2, Math.min(100, overall)).toFixed(1)}%`;
  const mb = typeof p.mb === 'number' ? `  ·  ${p.mb.toFixed(1)} MB` : '';
  setupText.textContent = `Downloading ${p.label || 'tools'} (${step} of ${steps})${mb}`;
});

async function refreshState() {
  try {
    const state = await invoke('get_state');
    outDirEl.textContent = state.outDir;
    outDirEl.title = state.outDir;
    toolsReady = Boolean(state.tools && state.tools.ready);
    updateLocks();
    if (!toolsReady) runSetup();
  } catch (err) {
    toolsEl.hidden = false;
    toolsEl.textContent = errText(err, 'Something went wrong starting up.');
  }
}

setupRetry.addEventListener('click', runSetup);

changeDirBtn.addEventListener('click', async () => {
  try {
    const dir = await invoke('pick_folder');
    outDirEl.textContent = dir;
    outDirEl.title = dir;
    fx().blip('tick');
  } catch (err) {
    showAlert(errText(err, 'Could not change the folder.'));
  }
});

openDirBtn.addEventListener('click', async () => {
  try {
    await invoke('open_folder');
  } catch (err) {
    showAlert(errText(err, 'Could not open the folder.'));
  }
});

// ---------- preview and history ----------

function renderPreview(preview) {
  currentPreview = preview;
  previewEl.hidden = false;
  titleEl.textContent = preview.title || 'YouTube video';
  kindEl.textContent = preview.type === 'playlist' ? 'Playlist' : 'Video';
  const bits = [preview.uploader, preview.durationText].filter(Boolean);
  subEl.textContent = bits.join('  ·  ');
  if (preview.thumbnail) {
    thumbEl.src = preview.thumbnail;
    thumbEl.hidden = false;
  } else {
    thumbEl.removeAttribute('src');
    thumbEl.hidden = true;
  }
  updateLocks();
}

async function loadHistory() {
  let items = [];
  try {
    items = await invoke('history');
  } catch {
    items = [];
  }
  historyList.innerHTML = '';
  historyEmpty.hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    if (!item.exists) li.classList.add('missing');
    const img = document.createElement('img');
    img.alt = '';
    if (item.thumbnail) img.src = item.thumbnail;
    const body = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = item.title || item.filename;
    const p = document.createElement('p');
    p.textContent = [fileLabel(item), formatBytes(item.bytes), formatWhen(item.createdAt), item.exists ? '' : 'moved or deleted']
      .filter(Boolean)
      .join('  ·  ');
    body.append(h3, p);
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    if (item.exists) {
      actions.append(
        button(item.format === 'mp4' ? 'Play' : 'Play', 'btn ghost tiny', () => openFile(item.path)),
        button('Show', 'btn ghost tiny', () => revealFile(item.path))
      );
    }
    actions.append(
      button('Remove', 'btn quiet tiny', async () => {
        await invoke('remove_history', { id: item.id });
        fx().blip('tick');
        loadHistory();
      })
    );
    li.append(img, body, actions);
    historyList.append(li);
  }
}

function setBusy(next) {
  busy = next;
  cancelBtn.hidden = !next;
  fx().setConverting(next);
  updateLocks();
  if (!next) urlInput.focus();
}

function setProgress(percent, label, sub) {
  progressWrap.hidden = false;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  barFill.style.setProperty('--p', `${value}%`);
  if (pipetteFill) pipetteFill.style.height = `${value}%`;
  const gel = document.querySelector('.gel');
  if (gel) gel.setAttribute('aria-valuenow', String(Math.round(value)));
  progressPct.textContent = `${Math.round(value)}%`;
  if (label) progressLabel.textContent = label;
  progressSub.textContent = sub || '';
  fx().setPulse(value);
}

function showFiles(files) {
  resultEl.hidden = false;
  resultEl.innerHTML = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const left = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'name';
    name.textContent = file.title || file.filename;
    const bytes = document.createElement('p');
    bytes.className = 'bytes';
    bytes.textContent = 'Saved  ·  ' + [fileLabel(file), formatBytes(file.bytes)].filter(Boolean).join('  ·  ');
    left.append(name, bytes);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(
      button('Play', 'btn ghost tiny', () => openFile(file.path)),
      button('Show in folder', 'btn primary tiny', () => revealFile(file.path))
    );
    row.append(left, actions);
    resultEl.append(row);
  }
}

// ---------- job events ----------

let lastPercent = 0;

listen('job', (event) => {
  const p = event.payload || {};
  if (p.type === 'status') {
    setProgress(Math.max(lastPercent, 4), p.message, '');
  } else if (p.type === 'progress') {
    lastPercent = p.percent;
    const extra = [p.speed, p.eta ? `ETA ${p.eta}` : ''].filter(Boolean).join('  ·  ');
    setProgress(p.percent, p.format === 'mp4' ? 'Downloading video' : 'Extracting audio', extra);
    fx().blip('tick');
  } else if (p.type === 'done') {
    setProgress(100, 'Complete', '');
    showFiles(p.files || []);
    setBusy(false);
    fx().blip('done');
    loadHistory();
  } else if (p.type === 'error') {
    showAlert(p.message || 'Conversion failed.');
    fx().blip('error');
    setBusy(false);
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!toolsReady) return;
  fx().ensureAudio();
  showAlert('');
  resultEl.hidden = true;
  progressWrap.hidden = true;
  currentPreview = null;
  previewBtn.disabled = true;
  convertBtn.disabled = true;
  const oldText = previewBtn.textContent;
  previewBtn.textContent = 'Scanning...';
  fx().blip('scan');
  try {
    const preview = await invoke('preview', {
      url: urlInput.value.trim(),
      playlist: playlistInput.checked,
    });
    renderPreview(preview);
  } catch (err) {
    previewEl.hidden = true;
    fx().blip('error');
    showAlert(errText(err, 'Could not fetch video info.'));
  } finally {
    previewBtn.textContent = oldText;
    updateLocks();
  }
});

convertBtn.addEventListener('click', async () => {
  fx().ensureAudio();
  showAlert('');
  resultEl.hidden = true;
  lastPercent = 0;
  setProgress(1, 'Starting', '');
  setBusy(true);
  fx().blip('start');
  try {
    await invoke('convert', {
      req: {
        url: urlInput.value.trim(),
        format: selectedFormat(),
        quality: selectedQuality(),
        resolution: selectedResolution(),
        playlist: playlistInput.checked,
        preview: currentPreview,
      },
    });
  } catch (err) {
    showAlert(errText(err, 'Could not start the conversion.'));
    fx().blip('error');
    setBusy(false);
  }
});

cancelBtn.addEventListener('click', async () => {
  await invoke('cancel');
});

urlInput.addEventListener('input', () => {
  currentPreview = null;
  updateLocks();
});

urlInput.addEventListener('paste', () => {
  // Auto scan right after a paste for a snappier feel.
  setTimeout(() => {
    if (toolsReady && !busy && /^https?:\/\//i.test(urlInput.value.trim())) {
      form.requestSubmit();
    }
  }, 60);
});

playlistInput.addEventListener('change', () => {
  currentPreview = null;
  updateLocks();
});

for (const input of form.querySelectorAll('input[name="format"]')) {
  input.addEventListener('change', syncFormatUi);
}

syncFormatUi();
refreshState();
loadHistory();
urlInput.focus();
