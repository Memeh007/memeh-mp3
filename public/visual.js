'use strict';

const MemehFX = (() => {
  const helixCanvas = document.getElementById('helix');
  const planariaCanvas = document.getElementById('planaria');
  const mascotLine = document.getElementById('mascotLine');
  const muteBtn = document.getElementById('muteBtn');

  const state = {
    pulse: 0,
    targetPulse: 0,
    converting: false,
    sound: localStorage.getItem('memeh-sound') !== 'off',
    audio: null,
    lastTick: 0,
  };

  function resize(canvas, cssMax) {
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(140, Math.min(rect.width || cssMax, cssMax));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(size * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    return dpr;
  }

  function drawCube(ctx, x, y, s, color) {
    const hx = s * 0.55;
    const hy = s * 0.32;
    const top = shade(color, 1.25);
    const left = color;
    const right = shade(color, 0.65);
    ctx.beginPath();
    ctx.moveTo(x, y - hy);
    ctx.lineTo(x + hx, y);
    ctx.lineTo(x, y + hy);
    ctx.lineTo(x - hx, y);
    ctx.closePath();
    ctx.fillStyle = top;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - hx, y);
    ctx.lineTo(x, y + hy);
    ctx.lineTo(x, y + hy + s * 0.7);
    ctx.lineTo(x - hx, y + s * 0.7);
    ctx.closePath();
    ctx.fillStyle = left;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + hx, y);
    ctx.lineTo(x, y + hy);
    ctx.lineTo(x, y + hy + s * 0.7);
    ctx.lineTo(x + hx, y + s * 0.7);
    ctx.closePath();
    ctx.fillStyle = right;
    ctx.fill();
  }

  function shade(hex, amt) {
    const n = hex.replace('#', '');
    const r = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(0, 2), 16) * amt)));
    const g = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(2, 4), 16) * amt)));
    const b = Math.max(0, Math.min(255, Math.round(parseInt(n.slice(4, 6), 16) * amt)));
    return `rgb(${r},${g},${b})`;
  }

  function drawHelix(time) {
    const canvas = helixCanvas;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const wCss = Math.max(160, rect.width || 220);
    const hCss = wCss;
    if (canvas.width !== Math.round(wCss * dpr) || canvas.height !== Math.round(hCss * dpr)) {
      canvas.width = Math.round(wCss * dpr);
      canvas.height = Math.round(hCss * dpr);
    }
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    state.pulse += (state.targetPulse - state.pulse) * 0.08;
    const rotY = time * 0.00055;
    const rotX = 0.55;
    const scale = (0.92 + state.pulse * 0.22) * (w / 360);
    const voxels = [];
    const turns = 3.15;
    const steps = 72;
    const radius = 52;
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * turns * Math.PI * 2;
      const y = (i / steps - 0.5) * 210;
      for (const phase of [0, Math.PI]) {
        voxels.push({
          x: Math.cos(a + phase) * radius,
          y,
          z: Math.sin(a + phase) * radius,
          color: phase === 0 ? '#3cffd0' : '#ff4fd8',
          size: 8,
        });
      }
      if (i % 4 === 0) {
        const x1 = Math.cos(a) * radius;
        const z1 = Math.sin(a) * radius;
        const x2 = Math.cos(a + Math.PI) * radius;
        const z2 = Math.sin(a + Math.PI) * radius;
        for (let k = 1; k <= 3; k += 1) {
          const f = k / 4;
          voxels.push({
            x: x1 + (x2 - x1) * f,
            y,
            z: z1 + (z2 - z1) * f,
            color: '#d6ff3a',
            size: 6,
          });
        }
      }
    }

    const points = voxels.map((p) => {
      let x = p.x;
      let y = p.y;
      let z = p.z;
      const x2 = x * Math.cos(rotY) + z * Math.sin(rotY);
      const z2 = -x * Math.sin(rotY) + z * Math.cos(rotY);
      const y2 = y * Math.cos(rotX) - z2 * Math.sin(rotX);
      const z3 = y * Math.sin(rotX) + z2 * Math.cos(rotX);
      const f = 260 / (260 + z3);
      return {
        x: w / 2 + x2 * f * scale,
        y: h / 2 + y2 * f * scale,
        z: z3,
        s: p.size * f * scale,
        color: p.color,
      };
    }).sort((a, b) => a.z - b.z);

    const glow = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.45);
    glow.addColorStop(0, `rgba(60,255,208,${0.08 + state.pulse * 0.18})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    for (const p of points) {
      drawCube(ctx, p.x, p.y, p.s, p.color);
    }
  }

  const PLANARIA = [
    '................................',
    '..2222................2222......',
    '.221112..............211122.....',
    '.21111122...2222...22111112.....',
    '..211111122211112221111112......',
    '...211111111111111111112........',
    '....2111133111113311112.........',
    '.....21114411111441112..........',
    '......211111111111112...........',
    '.......2111111111112............',
    '........21111111112.............',
    '.........211111112..............',
    '..........2111112...............',
    '...........21112................',
    '............212.................',
    '.............2..................',
    '................................',
  ];

  const PALETTE = {
    1: '#f3c2b0',
    2: '#d48978',
    3: '#1a1020',
    4: '#3cffd0',
  };

  function drawPlanaria(time) {
    const canvas = planariaCanvas;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const wCss = Math.max(180, rect.width || 220);
    const hCss = wCss * (180 / 280);
    if (canvas.width !== Math.round(wCss * dpr) || canvas.height !== Math.round(hCss * dpr)) {
      canvas.width = Math.round(wCss * dpr);
      canvas.height = Math.round(hCss * dpr);
    }
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;

    const rows = PLANARIA.length;
    const cols = PLANARIA[0].length;
    const pixel = Math.floor(Math.min(w / (cols + 4), h / (rows + 8)));
    const ox = Math.floor((w - cols * pixel) / 2);
    const oy = Math.floor((h - rows * pixel) / 2);
    const speed = state.converting ? 0.01 : 0.004;
    const amp = state.converting ? 2.4 : 1.1;

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const ch = PLANARIA[y][x];
        if (ch === '.') continue;
        const wave = Math.sin(time * speed + x * 0.45 + y * 0.12) * amp * pixel * 0.35;
        const wobbleX = state.converting ? Math.sin(time * speed * 1.6 + y * 0.5) * pixel * 0.25 : 0;
        ctx.fillStyle = PALETTE[ch];
        ctx.fillRect(
          Math.round(ox + x * pixel + wobbleX),
          Math.round(oy + y * pixel + wave),
          pixel,
          pixel
        );
      }
    }
  }

  function ensureAudio() {
    if (!state.audio) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      state.audio = new Ctx();
    }
    if (state.audio.state === 'suspended') state.audio.resume();
    return state.audio;
  }

  function tone(freq, dur, type, gain) {
    if (!state.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain || 0.03, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }

  function blip(kind) {
    if (kind === 'scan') {
      tone(660, 0.07, 'square', 0.03);
      setTimeout(() => tone(880, 0.08, 'square', 0.025), 70);
    } else if (kind === 'start') {
      tone(220, 0.09, 'square', 0.03);
      setTimeout(() => tone(330, 0.1, 'square', 0.03), 80);
    } else if (kind === 'tick') {
      const now = performance.now();
      if (now - state.lastTick < 180) return;
      state.lastTick = now;
      tone(1400, 0.03, 'square', 0.012);
    } else if (kind === 'done') {
      tone(523, 0.08, 'square', 0.03);
      setTimeout(() => tone(659, 0.08, 'square', 0.03), 90);
      setTimeout(() => tone(784, 0.14, 'square', 0.03), 180);
    } else if (kind === 'error') {
      tone(180, 0.16, 'sawtooth', 0.03);
      setTimeout(() => tone(120, 0.2, 'sawtooth', 0.03), 120);
    }
  }

  function setConverting(on) {
    state.converting = on;
    if (!on) state.targetPulse = Math.min(state.targetPulse, 0.2);
    if (mascotLine) {
      mascotLine.textContent = on ? 'converting' : 'ready';
    }
  }

  function setPulse(percent) {
    state.targetPulse = Math.max(0, Math.min(1, (Number(percent) || 0) / 100));
  }

  function syncMute() {
    if (!muteBtn) return;
    muteBtn.textContent = state.sound ? 'SOUND ON' : 'SOUND OFF';
    muteBtn.setAttribute('aria-pressed', state.sound ? 'false' : 'true');
  }

  if (muteBtn) {
    syncMute();
    muteBtn.addEventListener('click', () => {
      state.sound = !state.sound;
      localStorage.setItem('memeh-sound', state.sound ? 'on' : 'off');
      if (state.sound) {
        ensureAudio();
        blip('tick');
      }
      syncMute();
    });
  }

  function loop(time) {
    drawHelix(time);
    drawPlanaria(time);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return { setConverting, setPulse, blip, ensureAudio };
})();
