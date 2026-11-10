// Film-style digital rain, ported from the matrix example widget and dimmed so terminal text stays readable on top.
// Effect interface (public/fx.js drives it): start(canvas, { animate }), stop(), resize(). One instance per page.
const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾈﾉ0123456789:=*+-<>'.split('');
const FS = 16, CW = 12.5, CH = 17, DIM = 0.42, FPS = 30; // font size, column pitch, row pitch, overall strength, frame cap
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

let cv = null, ctx = null, raf = 0, last = 0, T = 0, cols = 0, rows = 0, lum = [], chr = [], streams = [], info = [];

const newStream = (c, y) => ({ y, spd: 6 + Math.random() * 18 * info[c].depth + info[c].depth * 6 });
// How busy a column is right now: slow sine waves across the width, so dense and empty stretches drift about.
const busy = (c) => { const k = (Math.sin(c * 0.29 + T * 0.17) + Math.sin(c * 0.071 - T * 0.11) + 0.4 * Math.sin(c * 1.7 + T * 0.9)) / 2.4; const u = (k + 1) / 2; return 0.2 + 1.6 * u * u; };

function resize() {
  if (!cv) return;
  cv.width = Math.max(1, cv.clientWidth); cv.height = Math.max(1, cv.clientHeight); // device pixel ratio 1 on purpose: cheap, and the glyphs are dim anyway
  cols = Math.ceil(cv.clientWidth / CW); rows = Math.ceil(cv.clientHeight / CH) + 1;
  lum = []; chr = []; streams = []; info = [];
  for (let c = 0; c < cols; c++) {
    const depth = 0.3 + Math.random() * 0.7;
    info.push({ depth, decay: 0.3 + Math.random() * 1.1 });
    lum.push(new Float32Array(rows)); chr.push(Array.from({ length: rows }, glyph)); streams.push([]);
    for (let k = 0; k < 3; k++) if (Math.random() < 0.55) streams[c].push(newStream(c, Math.random() * rows));
  }
}

function step(dt) {
  T += dt;
  for (let c = 0; c < cols; c++) {
    const L = lum[c], S = streams[c], inf = info[c];
    if (S.length < 3 && Math.random() < busy(c) * dt) S.push(newStream(c, -Math.random() * 3));
    for (let i = S.length - 1; i >= 0; i--) {
      const s = S[i], from = Math.floor(s.y); s.y += s.spd * dt;
      for (let r = from + 1; r <= Math.floor(s.y); r++) { s.ch = glyph(); if (r >= 0 && r < rows && Math.random() > 0.1) { L[r] = 1; chr[c][r] = s.ch; } }
      if (s.y > rows + 2) S.splice(i, 1);
    }
    for (let r = 0; r < rows; r++) if (L[r] > 0) { L[r] = Math.max(0, L[r] - inf.decay * dt); if (Math.random() < 2.5 * dt) chr[c][r] = glyph(); }
  }
}

function draw() {
  const w = cv.width, h = cv.height;
  ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); // an opaque base: the effect shows whatever the transparency setting is
  ctx.font = `bold ${FS}px monospace`; ctx.textBaseline = 'top'; ctx.shadowBlur = 0;
  for (let c = 0; c < cols; c++) {
    const L = lum[c], a = (0.5 + 0.5 * info[c].depth) * DIM;
    for (let r = 0; r < rows; r++) {
      const b = L[r]; if (b < 0.04) continue;
      ctx.fillStyle = `hsl(126 100% ${(5 + 52 * Math.pow(b, 1.35)) * a * 2.2}%)`;
      ctx.fillText(chr[c][r], c * CW, r * CH);
    }
  }
  ctx.shadowColor = '#3dff5f'; ctx.shadowBlur = 4; ctx.fillStyle = '#b4ffc0';
  for (let c = 0; c < cols; c++) for (const s of streams[c]) {
    const r = Math.floor(s.y); if (r < 0 || r >= rows || !s.ch) continue;
    ctx.globalAlpha = (0.35 + 0.5 * info[c].depth) * DIM; ctx.fillText(s.ch, c * CW, r * CH);
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (document.hidden || t - last < 1000 / FPS) return; // paused in a background tab; capped to keep the CPU cost low
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  step(dt); draw();
}

export default {
  name: 'matrix',
  start(canvas, { animate = true } = {}) {
    cv = canvas; ctx = cv.getContext('2d'); resize();
    if (!animate) { for (let i = 0; i < 90; i++) step(1 / 30); draw(); return; } // reduced motion: one still frame
    last = performance.now(); raf = requestAnimationFrame(frame);
  },
  stop() { cancelAnimationFrame(raf); raf = 0; cv = ctx = null; },
  resize() { resize(); if (cv && !raf) { for (let i = 0; i < 90; i++) step(1 / 30); draw(); } },
};
