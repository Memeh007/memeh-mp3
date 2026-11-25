'use strict';

const express = require('express');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5050;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const BIN_DIR = path.join(ROOT, 'bin');
const QUALITIES = new Set([128, 192, 320]);
const MAX_HISTORY = 40;
const MAX_PLAYLIST_ITEMS = 25;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

const jobs = new Map();
const clients = new Map();

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(items, null, 2));
}

function addHistory(entry) {
  const items = loadHistory().filter((item) => item.id !== entry.id);
  items.unshift(entry);
  saveHistory(items.slice(0, MAX_HISTORY));
}

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [cmd], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || null;
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveYtDlp() {
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return firstExisting([
    path.join(BIN_DIR, exe),
    path.join(BIN_DIR, 'yt-dlp'),
    process.env.YT_DLP_PATH,
  ]) || which(exe) || which('yt-dlp');
}

function resolveFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return firstExisting([
    path.join(BIN_DIR, exe),
    path.join(BIN_DIR, 'ffmpeg'),
    process.env.FFMPEG_PATH,
  ]) || which(exe) || which('ffmpeg');
}

function toolStatus() {
  const ytDlp = resolveYtDlp();
  const ffmpeg = resolveFfmpeg();
  return {
    ytDlp: ytDlp ? { ok: true, path: ytDlp } : { ok: false, path: null },
    ffmpeg: ffmpeg ? { ok: true, path: ffmpeg } : { ok: false, path: null },
    ready: Boolean(ytDlp && ffmpeg),
  };
}

function parseYouTubeUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;
  if (parsed.username || parsed.password) return null;
  parsed.hash = '';
  return parsed.toString();
}

function isSafeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(id);
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  const total = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function safeBaseName(title, fallback) {
  const raw = String(title || fallback || 'audio')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return raw || fallback || 'audio';
}

function runYtDlp(args, opts = {}) {
  const ytDlp = resolveYtDlp();
  if (!ytDlp) {
    const err = new Error('yt-dlp is not installed');
    err.code = 'TOOLS_MISSING';
    throw err;
  }
  const ffmpeg = resolveFfmpeg();
  const finalArgs = [...args];
  if (ffmpeg) {
    finalArgs.unshift('--ffmpeg-location', ffmpeg);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlp, finalArgs, {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(Object.assign(new Error('Timed out talking to YouTube'), { code: 'TIMEOUT' }));
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
      if (opts.onStdout) opts.onStdout(buf.toString('utf8'));
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
      if (opts.onStderr) opts.onStderr(buf.toString('utf8'));
    });
    if (opts.onSpawn) opts.onSpawn(child);
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const message = tidyYtError(stderr || stdout) || `yt-dlp exited with code ${code}`;
        const err = new Error(message);
        err.code = 'YTDLP';
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function tidyYtError(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^ERROR:\s*/i, '').trim())
    .filter(Boolean);
  const useful = lines.reverse().find((line) =>
    /private|unavailable|copyright|sign in|age|removed|not a valid|unsupported|http error|video|playlist|geo|region/i.test(line)
  ) || lines[0];
  if (!useful) return null;
  return useful.slice(0, 400);
}

function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const best = thumbs.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best ? best.url : null;
}

function summarizeInfo(info, playlist) {
  if (!info) return null;
  if (info._type === 'playlist' || playlist) {
    const entries = (info.entries || []).filter(Boolean);
    const first = entries[0] || {};
    return {
      type: 'playlist',
      id: info.id || info.playlist_id || null,
      title: info.title || info.playlist_title || 'Playlist',
      thumbnail: pickThumbnail(info) || pickThumbnail(first),
      duration: null,
      durationText: entries.length ? `${Math.min(entries.length, MAX_PLAYLIST_ITEMS)} tracks` : null,
      uploader: info.uploader || info.channel || first.uploader || null,
      itemCount: info.playlist_count || entries.length || null,
      webpageUrl: info.webpage_url || info.original_url || null,
    };
  }
  return {
    type: 'video',
    id: info.id || null,
    title: info.title || 'YouTube video',
    thumbnail: pickThumbnail(info),
    duration: Number.isFinite(info.duration) ? info.duration : null,
    durationText: formatDuration(info.duration),
    uploader: info.uploader || info.channel || null,
    itemCount: 1,
    webpageUrl: info.webpage_url || info.original_url || null,
  };
}

function emit(jobId, event, data) {
  const job = jobs.get(jobId);
  if (job) {
    job.events.push({ event, data, at: Date.now() });
  }
  const list = clients.get(jobId) || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of list) {
    try {
      res.write(payload);
    } catch {
      // client gone
    }
  }
}

function attachClient(jobId, res) {
  if (!clients.has(jobId)) clients.set(jobId, []);
  clients.get(jobId).push(res);
  const job = jobs.get(jobId);
  if (job) {
    for (const ev of job.events) {
      res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }
  }
  res.on('close', () => {
    const next = (clients.get(jobId) || []).filter((item) => item !== res);
    if (next.length) clients.set(jobId, next);
    else clients.delete(jobId);
  });
}

function parseProgress(chunk, job) {
  const text = String(chunk);
  job.log = ((job.log || '') + text).slice(-8000);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const itemMatch = line.match(/Downloading item (\d+) of (\d+)/i);
    if (itemMatch) {
      job.itemIndex = Number(itemMatch[1]);
      job.itemTotal = Number(itemMatch[2]);
      emit(job.id, 'status', {
        phase: 'download',
        message: `Track ${job.itemIndex} of ${job.itemTotal}`,
        itemIndex: job.itemIndex,
        itemTotal: job.itemTotal,
      });
    }
    const pctMatch = line.match(/(\d{1,3}(?:\.\d+)?)%/);
    const isDownload = /\[download\]/.test(line) || /^download:/i.test(line);
    if (pctMatch && (isDownload || job.phase === 'download')) {
      const percent = Math.max(0, Math.min(100, Number(pctMatch[1])));
      job.percent = percent;
      const speed = (line.match(/at\s+(\S+)/) || [])[1];
      const eta = (line.match(/ETA\s+(\S+)/) || [])[1];
      emit(job.id, 'progress', {
        percent,
        speed: speed && speed !== 'Unknown' ? speed : null,
        eta: eta && eta !== 'Unknown' ? eta : null,
        phase: 'download',
      });
    }
    if (/\[ExtractAudio\]|Destination:.*\.mp3/i.test(line)) {
      job.phase = 'convert';
      emit(job.id, 'status', { phase: 'convert', message: 'Converting to MP3' });
    }
    if (/\[EmbedThumbnail\]|\[Metadata\]|Adding metadata|Embedding/i.test(line)) {
      job.phase = 'tag';
      emit(job.id, 'status', { phase: 'tag', message: 'Adding artwork and tags' });
    }
  }
}

async function startConversion(job) {
  const outDir = path.join(DOWNLOADS_DIR, job.id);
  fs.mkdirSync(outDir, { recursive: true });
  const template = path.join(outDir, '%(title).180B [%(id)s].%(ext)s');
  const args = [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', `${job.quality}K`,
    '--embed-metadata',
    '--embed-thumbnail',
    '--convert-thumbnails', 'jpg',
    '--no-overwrites',
    '--newline',
    '--progress',
    '--no-warnings',
    '--restrict-filenames',
    '-o', template,
  ];
  if (job.playlist) {
    args.push('--yes-playlist', '--playlist-end', String(MAX_PLAYLIST_ITEMS));
  } else {
    args.push('--no-playlist');
  }
  args.push('--', job.url);

  emit(job.id, 'status', { phase: 'fetch', message: 'Starting download' });
  job.phase = 'download';

  try {
    await runYtDlp(args, {
      timeoutMs: job.playlist ? 30 * 60 * 1000 : 15 * 60 * 1000,
      onSpawn: (child) => {
        job.child = child;
      },
      onStdout: (chunk) => parseProgress(chunk, job),
      onStderr: (chunk) => parseProgress(chunk, job),
    });

    if (job.cancelled) return;

    const files = collectMp3s(outDir);
    if (!files.length) {
      throw new Error('Conversion finished, but no MP3 file was created');
    }

    const items = files.map((file) => {
      const id = crypto.randomBytes(8).toString('hex');
      const publicName = path.basename(file);
      const entry = {
        id,
        jobId: job.id,
        title: prettyTitleFromFile(publicName),
        filename: publicName,
        relPath: path.relative(DOWNLOADS_DIR, file).replace(/\\/g, '/'),
        quality: job.quality,
        url: job.url,
        thumbnail: job.preview && job.preview.thumbnail ? job.preview.thumbnail : null,
        durationText: job.preview && job.preview.type === 'video' ? job.preview.durationText : null,
        createdAt: new Date().toISOString(),
        bytes: safeSize(file),
      };
      addHistory(entry);
      return entry;
    });

    job.status = 'done';
    job.files = items;
    emit(job.id, 'done', { files: items });
  } catch (err) {
    if (job.cancelled) return;
    job.status = 'error';
    job.error = err.message || 'Conversion failed';
    emit(job.id, 'error', { message: job.error });
  } finally {
    job.child = null;
    setTimeout(() => {
      jobs.delete(job.id);
      clients.delete(job.id);
    }, JOB_TTL_MS);
  }
}

function collectMp3s(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...collectMp3s(full));
    else if (/\.mp3$/i.test(name)) out.push(full);
  }
  return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function prettyTitleFromFile(name) {
  return name
    .replace(/\.mp3$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s*\[([a-zA-Z0-9_-]{6,})\]\s*$/, '')
    .trim();
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function resolveDownloadFile(relPath) {
  if (!relPath || relPath.includes('\0')) return null;
  const decoded = decodeURIComponent(relPath);
  const full = path.resolve(DOWNLOADS_DIR, decoded);
  const root = path.resolve(DOWNLOADS_DIR);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  if (!/\.mp3$/i.test(full)) return null;
  return full;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/api/health', (_req, res) => {
  const tools = toolStatus();
  res.json({
    ok: true,
    host: HOST,
    port: PORT,
    tools,
  });
});

app.get('/api/tools', (_req, res) => {
  res.json(toolStatus());
});

app.get('/api/history', (_req, res) => {
  res.json({ items: loadHistory() });
});

app.delete('/api/history/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return sendJson(res, 400, { error: 'Invalid item id' });
  const items = loadHistory();
  const found = items.find((item) => item.id === id);
  if (!found) return sendJson(res, 404, { error: 'Item not found' });
  const next = items.filter((item) => item.id !== id);
  saveHistory(next);
  if (found.relPath) {
    const file = resolveDownloadFile(found.relPath);
    if (file) {
      try {
        fs.unlinkSync(file);
      } catch {
        // keep history updated even if the file is already gone
      }
    }
  }
  res.json({ ok: true });
});

app.get('/api/file/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id)) return sendJson(res, 400, { error: 'Invalid file id' });
  const item = loadHistory().find((entry) => entry.id === id);
  if (!item || !item.relPath) return sendJson(res, 404, { error: 'File not found' });
  const file = resolveDownloadFile(item.relPath);
  if (!file) return sendJson(res, 404, { error: 'The MP3 is no longer on disk' });
  res.download(file, item.filename || path.basename(file), (err) => {
    if (err && !res.headersSent) sendJson(res, 500, { error: 'Could not send the file' });
  });
});

app.post('/api/preview', async (req, res) => {
  const url = parseYouTubeUrl(req.body && req.body.url);
  const playlist = Boolean(req.body && req.body.playlist);
  if (!url) {
    return sendJson(res, 400, { error: 'That link does not look like a YouTube URL.' });
  }
  const tools = toolStatus();
  if (!tools.ytDlp.ok) {
    return sendJson(res, 503, {
      error: 'yt-dlp is missing. Run start.bat or node install-tools.js, then try again.',
    });
  }
  const args = ['--dump-single-json', '--no-download', '--no-warnings', '--skip-download'];
  if (playlist) args.push('--yes-playlist', '--playlist-end', String(MAX_PLAYLIST_ITEMS), '--flat-playlist');
  else args.push('--no-playlist');
  args.push('--', url);
  try {
    const result = await runYtDlp(args, { timeoutMs: 45000 });
    const info = JSON.parse(result.stdout);
    const preview = summarizeInfo(info, playlist);
    res.json({ preview, url });
  } catch (err) {
    const message =
      err.code === 'TIMEOUT'
        ? 'Timed out fetching video info. Check the link and try again.'
        : err.message || 'Could not fetch video info. The video may be private, region locked, or removed.';
    sendJson(res, 422, { error: message });
  }
});

app.post('/api/convert', (req, res) => {
  const url = parseYouTubeUrl(req.body && req.body.url);
  const playlist = Boolean(req.body && req.body.playlist);
  const quality = Number(req.body && req.body.quality);
  if (!url) {
    return sendJson(res, 400, { error: 'That link does not look like a YouTube URL.' });
  }
  if (!QUALITIES.has(quality)) {
    return sendJson(res, 400, { error: 'Choose 128, 192, or 320 kbps.' });
  }
  const tools = toolStatus();
  if (!tools.ready) {
    return sendJson(res, 503, {
      error: 'yt-dlp and ffmpeg are required. Run start.bat or node install-tools.js, then try again.',
      tools,
    });
  }
  const active = [...jobs.values()].filter((j) => j.status === 'running').length;
  if (active >= 2) {
    return sendJson(res, 429, { error: 'Two conversions are already running. Wait a moment, then try again.' });
  }
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    url,
    quality,
    playlist,
    preview: (req.body && req.body.preview) || null,
    status: 'running',
    phase: 'fetch',
    percent: 0,
    events: [],
    files: [],
    cancelled: false,
    child: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  setImmediate(() => startConversion(job));
  res.json({ jobId: id });
});

app.get('/api/events/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id) || !jobs.has(id)) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n');
  attachClient(id, res);
});

app.post('/api/cancel/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeId(id) || !jobs.has(id)) {
    return sendJson(res, 404, { error: 'Job not found' });
  }
  const job = jobs.get(id);
  job.cancelled = true;
  job.status = 'cancelled';
  if (job.child) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(job.child.pid), '/t', '/f'], { windowsHide: true });
      } else {
        job.child.kill('SIGTERM');
      }
    } catch {
      // already exited
    }
  }
  emit(id, 'error', { message: 'Conversion cancelled.' });
  res.json({ ok: true });
});

app.use('/api', (_req, res) => {
  sendJson(res, 404, { error: 'Unknown API route' });
});

const server = app.listen(PORT, HOST, () => {
  const tools = toolStatus();
  console.log(`Memeh MP3 listening on http://${HOST}:${PORT}`);
  console.log(`yt-dlp: ${tools.ytDlp.ok ? tools.ytDlp.path : 'MISSING'}`);
  console.log(`ffmpeg: ${tools.ffmpeg.ok ? tools.ffmpeg.path : 'MISSING'}`);
  if (!tools.ready) {
    console.log('Tools missing. Run: node install-tools.js');
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other Memeh MP3 window, or set PORT to another value.`);
    process.exit(1);
  }
  throw err;
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
