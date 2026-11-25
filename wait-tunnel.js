'use strict';

const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'tunnel.log');
const outFile = path.join(__dirname, 'SHARE_URL.txt');
const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const deadline = Date.now() + 45000;

function tick() {
  try {
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile, 'utf8');
      const match = text.match(pattern);
      if (match) {
        fs.writeFileSync(outFile, `${match[0]}\n`);
        process.stdout.write(`${match[0]}\n`);
        process.exit(0);
      }
    }
  } catch {
    // the log may still be opening
  }
  if (Date.now() > deadline) {
    console.error('The tunnel URL did not appear. Check tunnel.log, or look at the Memeh MP3 tunnel window.');
    process.exit(1);
  }
  setTimeout(tick, 500);
}

tick();
