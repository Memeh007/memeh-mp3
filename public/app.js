'use strict';

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

let currentPreview = null;
let currentJobId = null;
let eventSource = null;
let finished = false;

function fx() {
  return window.MemehFX || {
    setConverting() {},
    setPulse() {},
    blip() {},
    ensureAudio() {},
  };
}

function selectedQuality() {
  const chosen = form.querySelector('input[name="quality"]:checked');
  return Number(chosen ? chosen.value : 192);
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

async function readError(res) {
  try {
    const data = await res.json();
    return data.error || res.statusText;
  } catch {
    return res.statusText || 'Something went wrong.';
  }
}

async function refreshTools() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (!data.tools || data.tools.ready) {
      toolsEl.hidden = true;
      return;
    }
    const missing = [];
    if (!data.tools.ytDlp.ok) missing.push('yt-dlp');
    if (!data.tools.ffmpeg.ok) missing.push('ffmpeg');
    toolsEl.hidden = false;
    toolsEl.textContent = `Missing tools: ${missing.join(' and ')}. Close this page, run start.bat (or node install-tools.js), then refresh.`;
  } catch {
    toolsEl.hidden = false;
    toolsEl.textContent = 'The local server is not responding. Start it with start.bat.';
  }
}

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
  convertBtn.disabled = false;
}

async function loadHistory() {
  const res = await fetch('/api/history');
  const data = await res.json();
  const items = data.items || [];
  historyList.innerHTML = '';
  historyEmpty.hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = '';
    if (item.thumbnail) img.src = item.thumbnail;
    const body = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = item.title || item.filename;
    const p = document.createElement('p');
    p.textContent = [item.quality ? `${item.quality} kbps` : '', formatBytes(item.bytes), formatWhen(item.createdAt)]
      .filter(Boolean)
      .join('  ·  ');
    body.append(h3, p);
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const save = document.createElement('a');
    save.className = 'btn ghost tiny';
    save.href = `/api/file/${item.id}`;
    save.textContent = 'Save MP3';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn quiet tiny';
    del.textContent = 'Remove';
    del.addEventListener('click', async () => {
      await fetch(`/api/history/${item.id}`, { method: 'DELETE' });
      fx().blip('tick');
      loadHistory();
    });
    actions.append(save, del);
    li.append(img, body, actions);
    historyList.append(li);
  }
}

function setBusy(busy) {
  previewBtn.disabled = busy;
  convertBtn.disabled = busy || !currentPreview;
  cancelBtn.hidden = !busy;
  fx().setConverting(busy);
  if (!busy) urlInput.focus();
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

function closeEvents() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
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
    bytes.textContent = 'Ready to save  ·  ' + [file.quality ? `${file.quality} kbps` : '', formatBytes(file.bytes)].filter(Boolean).join('  ·  ');
    left.append(name, bytes);
    const link = document.createElement('a');
    link.className = 'btn primary tiny';
    link.href = `/api/file/${file.id}`;
    link.textContent = 'Save MP3';
    row.append(left, link);
    resultEl.append(row);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  fx().ensureAudio();
  showAlert('');
  resultEl.hidden = true;
  progressWrap.hidden = true;
  convertBtn.disabled = true;
  currentPreview = null;
  previewBtn.disabled = true;
  fx().blip('scan');
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: urlInput.value.trim(),
        playlist: playlistInput.checked,
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json();
    renderPreview(data.preview);
  } catch (err) {
    previewEl.hidden = true;
    fx().blip('error');
    showAlert(err.message || 'Could not fetch video info.');
  } finally {
    previewBtn.disabled = false;
  }
});

convertBtn.addEventListener('click', async () => {
  fx().ensureAudio();
  showAlert('');
  resultEl.hidden = true;
  finished = false;
  setProgress(1, 'Starting', '');
  setBusy(true);
  closeEvents();
  fx().blip('start');
  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: urlInput.value.trim(),
        quality: selectedQuality(),
        playlist: playlistInput.checked,
        preview: currentPreview,
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json();
    currentJobId = data.jobId;
    eventSource = new EventSource(`/api/events/${currentJobId}`);
    eventSource.addEventListener('status', (ev) => {
      const payload = JSON.parse(ev.data);
      const current = Number(String(barFill.style.getPropertyValue('--p')).replace('%', '')) || 4;
      setProgress(Math.max(current, 4), payload.message, '');
    });
    eventSource.addEventListener('progress', (ev) => {
      const payload = JSON.parse(ev.data);
      const extra = [payload.speed, payload.eta ? `ETA ${payload.eta}` : ''].filter(Boolean).join('  ·  ');
      setProgress(payload.percent, 'Extracting audio', extra);
      fx().blip('tick');
    });
    eventSource.addEventListener('done', (ev) => {
      const payload = JSON.parse(ev.data);
      finished = true;
      setProgress(100, 'Complete', '');
      showFiles(payload.files || []);
      setBusy(false);
      closeEvents();
      fx().blip('done');
      loadHistory();
    });
    eventSource.addEventListener('error', (ev) => {
      if (!ev.data) return;
      try {
        const payload = JSON.parse(ev.data);
        showAlert(payload.message || 'Conversion failed.');
      } catch {
        showAlert('Conversion failed.');
      }
      finished = true;
      fx().blip('error');
      setBusy(false);
      closeEvents();
    });
    eventSource.onerror = () => {
      if (!finished && currentJobId && eventSource && eventSource.readyState === EventSource.CLOSED) {
        showAlert('Lost the connection to the converter.');
        fx().blip('error');
        setBusy(false);
        closeEvents();
      }
    };
  } catch (err) {
    showAlert(err.message || 'Could not start the conversion.');
    fx().blip('error');
    setBusy(false);
  }
});

cancelBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  await fetch(`/api/cancel/${currentJobId}`, { method: 'POST' });
});

urlInput.addEventListener('input', () => {
  convertBtn.disabled = true;
  currentPreview = null;
});

playlistInput.addEventListener('change', () => {
  convertBtn.disabled = true;
  currentPreview = null;
});

refreshTools();
loadHistory();
urlInput.focus();
