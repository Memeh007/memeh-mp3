'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const URL_PATTERN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/i;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readUrl() {
  const arg = process.argv[2] && process.argv[2].trim();
  if (arg) {
    if (!URL_PATTERN.test(arg)) fail('That does not look like a trycloudflare URL.');
    return arg.replace(/\/$/, '');
  }
  const file = path.join(__dirname, 'SHARE_URL.txt');
  if (!fs.existsSync(file)) fail('SHARE_URL.txt was not found.');
  const text = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].trim();
  if (!URL_PATTERN.test(text)) fail('SHARE_URL.txt does not contain a trycloudflare URL.');
  return text.replace(/\/$/, '');
}

function findRepo() {
  const candidates = [
    __dirname,
    path.join(os.homedir(), 'Desktop', 'memeh-mp3-repo'),
    path.join(__dirname, '..', 'memeh-mp3-repo'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, '.git'))) return candidate;
  }
  fail('Could not find the memeh-mp3 git repo on this computer.');
}

function writeLink(dir, url) {
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const payload = {
    url,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(docs, 'link.json'), `${JSON.stringify(payload, null, 2)}\n`);
}

function runGit(repo, args) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`git ${args.join(' ')} failed${detail ? ': ' + detail : ''}`);
  }
  return result;
}

const url = readUrl();
writeLink(__dirname, url);

const repo = findRepo();
writeLink(repo, url);

if (path.resolve(repo) !== path.resolve(__dirname)) {
  console.log(`Updated docs/link.json in ${repo}`);
}

runGit(repo, ['add', '--', 'docs/link.json']);
const status = spawnSync('git', ['status', '--porcelain', '--', 'docs/link.json'], {
  cwd: repo,
  encoding: 'utf8',
  windowsHide: true,
});
if (status.status !== 0) {
  fail('Could not check git status for docs/link.json');
}
if (!String(status.stdout || '').trim()) {
  console.log('The GitHub Pages link is already up to date.');
  console.log(`Friends can use: https://memeh007.github.io/memeh-mp3/`);
  process.exit(0);
}

runGit(repo, ['commit', '-m', 'Update the live share link']);
runGit(repo, ['push', 'origin', 'HEAD']);
console.log('Pushed the new share link to GitHub Pages.');
console.log(`Friends can use: https://memeh007.github.io/memeh-mp3/`);
