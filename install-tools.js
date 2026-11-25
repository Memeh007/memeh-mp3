'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');
const { tmpdir } = require('os');

const ROOT = __dirname;
const BIN = path.join(ROOT, 'bin');
fs.mkdirSync(BIN, { recursive: true });

const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URLS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];

function log(msg) {
  console.log(msg);
}

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [cmd], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean) || null;
}

function findLocal(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const direct = path.join(BIN, exe);
  if (exists(direct)) return direct;
  return which(exe) || which(name);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: opts.stdio || 'pipe',
    timeout: opts.timeout || 8 * 60 * 1000,
  });
  return result;
}

function wingetAvailable() {
  if (process.platform !== 'win32') return false;
  return Boolean(which('winget'));
}

function tryWinget(id) {
  log(`Trying winget for ${id}`);
  const result = run('winget', [
    'install',
    '-e',
    '--id',
    id,
    '--scope',
    'user',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ]);
  if (result.status === 0) {
    log(`winget installed ${id}`);
    return true;
  }
  log(`winget could not install ${id}${result.stderr ? ': ' + String(result.stderr).slice(0, 200) : ''}`);
  return false;
}

function followDownload(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'MemehMP3-installer',
          Accept: '*/*',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          followDownload(next, dest, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`Download failed (${status}) for ${url}`));
          return;
        }
        const out = createWriteStream(dest);
        pipeline(res, out).then(resolve).catch(reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(5 * 60 * 1000, () => {
      req.destroy(new Error('Download timed out'));
    });
  });
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const script = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const result = run('powershell', ['-NoProfile', '-Command', script]);
    if (result.status !== 0) {
      throw new Error(result.stderr || 'Could not unzip ffmpeg');
    }
    return;
  }
  const result = run('unzip', ['-o', zipPath, '-d', destDir]);
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Could not unzip ffmpeg');
  }
}

function findFile(dir, names) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (names.includes(entry.name.toLowerCase())) return full;
    }
  }
  return null;
}

async function ensureYtDlp() {
  const existing = findLocal('yt-dlp');
  if (existing) {
    log(`yt-dlp already available: ${existing}`);
    return existing;
  }
  if (wingetAvailable()) {
    if (tryWinget('yt-dlp.yt-dlp') || tryWinget('yt-dlp')) {
      const found = findLocal('yt-dlp');
      if (found) return found;
    }
  }
  if (process.platform !== 'win32') {
    throw new Error('yt-dlp was not found. Install it with your package manager and retry.');
  }
  const dest = path.join(BIN, 'yt-dlp.exe');
  log(`Downloading yt-dlp.exe from GitHub releases`);
  await followDownload(YT_DLP_URL, dest);
  log(`Saved ${dest}`);
  return dest;
}

async function ensureFfmpeg() {
  const existing = findLocal('ffmpeg');
  if (existing) {
    log(`ffmpeg already available: ${existing}`);
    return existing;
  }
  if (wingetAvailable()) {
    if (tryWinget('Gyan.FFmpeg') || tryWinget('Gyan.FFmpeg.Essentials') || tryWinget('FFmpeg')) {
      const found = findLocal('ffmpeg');
      if (found) return found;
    }
  }
  if (process.platform !== 'win32') {
    throw new Error('ffmpeg was not found. Install it with your package manager and retry.');
  }
  const zipPath = path.join(tmpdir(), `ffmpeg-yt2mp3-${Date.now()}.zip`);
  const extractDir = path.join(tmpdir(), `ffmpeg-yt2mp3-${Date.now()}`);
  let lastError = null;
  for (const url of FFMPEG_URLS) {
    try {
      log(`Downloading ffmpeg from ${url}`);
      await followDownload(url, zipPath);
      unzip(zipPath, extractDir);
      const found = findFile(extractDir, ['ffmpeg.exe']);
      if (!found) throw new Error('The zip did not contain ffmpeg.exe');
      const dest = path.join(BIN, 'ffmpeg.exe');
      fs.copyFileSync(found, dest);
      const ffprobe = findFile(extractDir, ['ffprobe.exe']);
      if (ffprobe) fs.copyFileSync(ffprobe, path.join(BIN, 'ffprobe.exe'));
      log(`Saved ${dest}`);
      try {
        fs.unlinkSync(zipPath);
      } catch {
        // temp cleanup is optional
      }
      return dest;
    } catch (err) {
      lastError = err;
      log(`ffmpeg download failed: ${err.message}`);
    }
  }
  throw lastError || new Error('Could not install ffmpeg');
}

const CLOUDFLARED_URLS = {
  win32: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  linux: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  darwin: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
};

async function ensureCloudflared() {
  const existing = findLocal('cloudflared');
  if (existing) {
    log(`cloudflared already available: ${existing}`);
    return existing;
  }
  if (wingetAvailable()) {
    if (tryWinget('Cloudflare.cloudflared')) {
      const found = findLocal('cloudflared');
      if (found) return found;
    }
  }
  const url = CLOUDFLARED_URLS[process.platform];
  if (!url || process.platform === 'darwin') {
    throw new Error('cloudflared was not found. Install it with your package manager and retry.');
  }
  const destName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const dest = path.join(BIN, destName);
  log(`Downloading cloudflared from GitHub releases`);
  await followDownload(url, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // chmod is only needed on Unix
  }
  log(`Saved ${dest}`);
  return dest;
}

async function main() {
  const wantShare = process.argv.includes('--cloudflared');
  log('Installing tools for Memeh MP3, user scope only.');
  const yt = await ensureYtDlp();
  const ff = await ensureFfmpeg();
  log(`yt-dlp: ${yt}`);
  log(`ffmpeg: ${ff}`);
  if (wantShare) {
    const cf = await ensureCloudflared();
    log(`cloudflared: ${cf}`);
  }
  log('All set.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
