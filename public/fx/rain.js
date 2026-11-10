// Rain on glass: small drops sit on the pane and grow; a heavy one slides down in stops and starts, swallows the drops it meets and
// leaves a thin wet trail that dries slowly. Plain 2D canvas, dim and soft so terminal text stays readable on top.
// Effect interface (public/fx.js drives it): start(canvas, { animate }), stop(), resize(). One instance per page.
const FPS = 30;
let cv = null, ctx = null, trail = null, tctx = null, raf = 0, last = 0, W = 0, H = 0, drops = [], frames = 0;
const rnd = (a, b) => a + Math.random() * (b - a);

const maxStatic = () => Math.min(260, Math.floor((W * H) / 3500));
const newDrop = (y = rnd(0, H)) => ({ x: rnd(0, W), y, r: 0.8 + Math.pow(Math.random(), 2) * 3.2, slide: false, pause: 0 });

function resize() {
  if (!cv) return;
  W = cv.width = Math.max(1, cv.clientWidth); H = cv.height = Math.max(1, cv.clientHeight); // device pixel ratio 1: cheap, and soft anyway
  trail = document.createElement('canvas'); trail.width = W; trail.height = H; tctx = trail.getContext('2d');
  drops = []; for (let i = 0; i < maxStatic() * 0.6; i++) drops.push(newDrop());
}

function step(dt) {
  if (drops.filter((d) => !d.slide).length < maxStatic() && Math.random() < dt * 40) drops.push(newDrop());
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    if (!d.slide) {
      d.r += dt * rnd(0.02, 0.22);                       // collects mist
      if (d.r > 4.3 + Math.random() * 1.6) { d.slide = true; d.vy = 12; }
      continue;
    }
    if (d.pause > 0) d.pause -= dt;
    else if (Math.random() < dt * 1.4) d.pause = rnd(0.15, 0.7); // sticks to the glass for a moment
    const target = d.pause > 0 ? 0 : 22 + d.r * 16;
    d.vy += (target - d.vy) * Math.min(1, dt * 6);
    const px = d.x, py = d.y;
    d.y += d.vy * dt; d.x += rnd(-0.5, 0.5) * dt * 12;
    d.r = Math.max(0.5, d.r - dt * 0.12);                // leaves water behind, so it slowly shrinks
    tctx.strokeStyle = 'rgba(190,215,235,0.16)'; tctx.lineWidth = Math.max(0.8, d.r * 0.55); tctx.lineCap = 'round';
    tctx.beginPath(); tctx.moveTo(px, py); tctx.lineTo(d.x, d.y); tctx.stroke();
    for (let j = drops.length - 1; j >= 0; j--) { // swallow a resting drop it touches
      const o = drops[j]; if (o === d || o.slide) continue;
      const dx = o.x - d.x, dy = o.y - d.y;
      if (dx * dx + dy * dy < (d.r + o.r * 0.8) ** 2) { d.r = Math.sqrt(d.r * d.r + o.r * o.r * 0.6); drops.splice(j, 1); if (j < i) i--; }
    }
    if (d.r < 2.2 && d.vy < 4) d.slide = false;          // ran dry: it rests again
    if (d.y > H + 12) { const k = drops.indexOf(d); if (k >= 0) drops.splice(k, 1); }
  }
  if ((++frames & 3) === 0) { tctx.globalCompositeOperation = 'destination-out'; tctx.fillStyle = 'rgba(0,0,0,0.035)'; tctx.fillRect(0, 0, W, H); tctx.globalCompositeOperation = 'source-over'; }
}

function draw() {
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0d1822'); g.addColorStop(1, '#070d13');
  ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); // an opaque base, so the effect shows at any transparency setting
  ctx.drawImage(trail, 0, 0);
  ctx.shadowColor = 'rgba(160,200,230,0.35)'; ctx.shadowBlur = 3;
  for (const d of drops) {
    const grad = ctx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.35, d.r * 0.1, d.x, d.y, d.r);
    grad.addColorStop(0, 'rgba(210,230,245,0.30)'); grad.addColorStop(0.7, 'rgba(120,160,190,0.12)'); grad.addColorStop(1, 'rgba(10,20,30,0.28)');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.ellipse(d.x, d.y, d.r * 0.85, d.r * (d.slide ? 1.15 : 1), 0, 0, 6.2832); ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (document.hidden || t - last < 1000 / FPS) return; // paused in a background tab; capped to keep the CPU cost low
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  step(dt); draw();
}

export default {
  name: 'rain',
  start(canvas, { animate = true } = {}) {
    cv = canvas; ctx = cv.getContext('2d'); resize();
    if (!animate) { for (let i = 0; i < 240; i++) step(1 / 30); draw(); return; } // reduced motion: one still frame
    last = performance.now(); raf = requestAnimationFrame(frame);
  },
  stop() { cancelAnimationFrame(raf); raf = 0; cv = ctx = trail = tctx = null; drops = []; },
  resize() { resize(); if (cv && !raf) { for (let i = 0; i < 240; i++) step(1 / 30); draw(); } },
};
