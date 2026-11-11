// Rain on a window pane, plain 2D canvas. The canvas stays transparent where nothing is drawn, so the page background and the terminal's
// translucent tint show through; everything is drawn with low alpha in cool blue-grey so terminal text stays readable on top.
// Layers: faint mist; many tiny static droplets (beads with a dark rim, a soft highlight and a lighter lower edge); larger drops that
// collect mist and nearby droplets, hang, then slide in short stop-and-go bursts leaving a tapered wet trail that dries; now and then a
// streak of fast drops. Effect interface (public/fx.js drives it): start(canvas, { animate }), stop(), resize(). One instance per page.
import { mergeRadius, growRadius, shedRadius, touches, trailFade, slideTarget, approachSpeed, stepBurst, beadCount, dropCount, streakSpecs } from './rain-physics.js';

// ---- Tuning knobs (all in canvas pixels / seconds; the canvas runs at device pixel ratio 1 on purpose) ----
export const P = {
  FPS: 30,                 // frame cap
  INTENSITY: 1,            // overall strength: multiplies every alpha (0.5 = half as visible, 1.6 = more)
  MIST: 0.05,              // alpha of the faint vertical haze (bottom of the pane is a little hazier)
  BEAD_DENSITY: 1400,      // canvas px^2 per tiny droplet (smaller = more speckle)
  BEAD_MAX: 700,           // hard cap on tiny droplets
  BEAD_R: [0.5, 2.2],      // radius range of tiny droplets (skewed toward small)
  DROP_DENSITY: 55000,     // canvas px^2 per large drop
  DROP_MIN: 3, DROP_MAX: 40, // bounds on the number of large drops
  SLIDE_R: [3.6, 5.6],     // radius at which a hanging drop lets go and starts to slide
  GROW: [0.03, 0.18],      // px/s a hanging drop grows by collecting mist
  SPEED: 1,                // multiplier on slide speed
  GO: [0.15, 0.6], STOP: [0.25, 1.4], // seconds a sliding drop moves / stands still, alternating
  WOBBLE: 14,              // sideways jitter while sliding (px/s)
  SHED: 0.0035,            // radius lost per px slid (water left behind)
  REST_R: 1.9,             // a slider that shrinks below this stops and becomes a tiny droplet
  TRAIL_LIFE: 7,           // seconds until a wet trail has dried
  TRAIL_ALPHA: 0.2,        // alpha of fresh trail (lighter than the glass)
  STREAK_EVERY: [7, 18],   // seconds between streaks of fast drops
  STREAK_COUNT: [3, 6],
};
const TAU = Math.PI * 2;
let cv = null, ctx = null, raf = 0, last = 0, W = 1, H = 1, T = 0, nextStreak = 0, beads = [], drops = [], trails = [], sprites = new Map();
const rnd = (a, b) => a + Math.random() * (b - a);
const between = ([a, b]) => rnd(a, b);

/** One refractive-looking bead: dark rim, faint body, lighter lower edge, soft highlight offset up-left. rx/ry: radii. */
export function drawBead(c, x, y, rx, ry) {
  if (!(rx > 0) || !(ry > 0)) return;
  const g = c.createRadialGradient(x - rx * 0.15, y - ry * 0.15, rx * 0.1, x, y, Math.max(rx, ry));
  g.addColorStop(0, 'rgba(170,195,220,0.07)'); g.addColorStop(0.65, 'rgba(120,150,180,0.06)'); g.addColorStop(1, 'rgba(5,10,18,0.34)');
  c.fillStyle = g; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU); c.fill();
  c.strokeStyle = 'rgba(200,222,240,0.24)'; c.lineWidth = Math.max(0.5, rx * 0.18);
  c.beginPath(); c.ellipse(x, y + ry * 0.08, rx * 0.82, ry * 0.82, 0, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
  const hx = x - rx * 0.38, hy = y - ry * 0.42, hr = Math.max(0.5, rx * 0.3);
  const h = c.createRadialGradient(hx, hy, 0, hx, hy, hr); h.addColorStop(0, 'rgba(240,248,255,0.6)'); h.addColorStop(1, 'rgba(240,248,255,0)');
  c.fillStyle = h; c.beginPath(); c.arc(hx, hy, hr, 0, TAU); c.fill();
}

// Tiny beads are drawn from a small cache of pre-rendered sprites (one per quarter-pixel radius): hundreds of them per frame stay cheap.
function sprite(r) {
  const key = Math.max(1, Math.round(r * 4)); let s = sprites.get(key);
  if (!s) {
    const rr = key / 4, size = Math.ceil(rr * 2 + 4), el = document.createElement('canvas'); el.width = el.height = size;
    drawBead(el.getContext('2d'), size / 2, size / 2, rr, rr); s = { el, size }; sprites.set(key, s);
  }
  return s;
}

const newBead = () => ({ x: rnd(0, W), y: rnd(0, H), r: P.BEAD_R[0] + Math.pow(Math.random(), 2.2) * (P.BEAD_R[1] - P.BEAD_R[0]), a: rnd(0.55, 1) });
const newDrop = (o = {}) => ({ x: rnd(0, W), y: rnd(0, H * 0.9), r: rnd(2, 3), slide: false, fast: false, vx: 0, vy: 0, limit: between(P.SLIDE_R), grow: between(P.GROW), burst: { moving: true, t: 0.3 }, trail: null, dead: false, ...o });
const nBeads = () => beadCount(W, H, P.BEAD_DENSITY, P.BEAD_MAX);
const nDrops = () => dropCount(W, H, P.DROP_DENSITY, P.DROP_MIN, P.DROP_MAX);

function reset() {
  beads = []; drops = []; trails = []; T = 0; nextStreak = between(P.STREAK_EVERY) * 0.5;
  for (let i = 0, n = Math.floor(nBeads() * 0.7); i < n; i++) beads.push(newBead());
  for (let i = 0, n = nDrops(); i < n; i++) drops.push(newDrop());
}

function resize() {
  if (!cv) return;
  W = cv.width = Math.max(1, cv.clientWidth); H = cv.height = Math.max(1, cv.clientHeight);
  reset();
}

function eat(d) { // the drop swallows tiny droplets it touches
  for (let k = beads.length - 1; k >= 0; k--) {
    const b = beads[k];
    if (touches(d, b)) { d.r = mergeRadius(d.r, b.r * 0.55); beads[k] = beads[beads.length - 1]; beads.pop(); }
  }
}

const detach = (d) => { d.trail = null; };
function addTrailPoint(d) {
  const t = d.trail; if (!t) return; const p = t.pts[t.pts.length - 1];
  if (!p || Math.hypot(d.x - p.x, d.y - p.y) >= 2.5) t.pts.push({ x: d.x, y: d.y, w: d.r * (d.fast ? 0.7 : 1.05), t: T });
}

function step(dt) {
  T += dt;
  if (beads.length < nBeads() && Math.random() < dt * 25) beads.push(newBead()); // mist settles as new droplets
  if (drops.filter((d) => !d.fast).length < nDrops() && Math.random() < dt * 0.8) drops.push(newDrop());
  if (T >= nextStreak) { nextStreak = T + between(P.STREAK_EVERY); for (const s of streakSpecs(W, P.STREAK_COUNT, Math.random)) { const d = newDrop({ ...s, slide: true, burst: { moving: true, t: rnd(0.8, 2) } }); d.trail = { pts: [] }; trails.push(d.trail); drops.push(d); } }
  for (const d of drops) {
    if (d.dead) continue;
    if (!d.slide) {
      d.r = growRadius(d.r, dt, d.grow); eat(d);
      if (d.r >= d.limit) { d.slide = true; d.burst = { moving: true, t: rnd(0.2, 0.5) }; d.trail = { pts: [] }; trails.push(d.trail); }
      continue;
    }
    d.burst = stepBurst(d.burst, dt, Math.random, d.fast ? { go: [0.8, 2], stop: [0.05, 0.2] } : { go: P.GO, stop: P.STOP });
    d.vy = approachSpeed(d.vy, d.burst.moving ? slideTarget(d.r, d.fast, P.SPEED) : 0, dt);
    d.vx += ((d.burst.moving ? rnd(-1, 1) * P.WOBBLE : 0) - d.vx * 4) * dt;
    const dy = d.vy * dt; d.y += dy; d.x += d.vx * dt;
    if (!d.fast) d.r = shedRadius(d.r, dy, P.SHED);
    if (dy > 0.3 && !d.fast && Math.random() < dy * 0.025 && beads.length < P.BEAD_MAX) beads.push({ x: d.x + rnd(-1, 1) * d.r * 0.4, y: d.y - d.r * 0.8, r: rnd(0.5, 1), a: rnd(0.55, 1) }); // a droplet left behind
    eat(d); addTrailPoint(d);
    for (const o of drops) if (o !== d && !o.dead && o.r <= d.r && touches(d, o, 0.7)) { d.r = mergeRadius(d.r, o.r); o.dead = true; detach(o); } // meets another drop: they join
    if (!d.fast && d.r < P.REST_R) { d.dead = true; detach(d); beads.push({ x: d.x, y: d.y, r: Math.max(0.6, d.r), a: 0.8 }); }
    else if (d.y - d.r > H) { d.dead = true; detach(d); }
  }
  drops = drops.filter((d) => !d.dead);
  for (const t of trails) { let k = 0; while (k < t.pts.length && trailFade(T - t.pts[k].t, P.TRAIL_LIFE).dead) k++; if (k) t.pts.splice(0, k); }
  trails = trails.filter((t) => t.pts.length > 1 || drops.some((d) => d.trail === t));
}

function drawTrail(t) {
  const p = t.pts;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], fa = trailFade(T - a.t, P.TRAIL_LIFE), fb = trailFade(T - b.t, P.TRAIL_LIFE);
    const alpha = (fa.alpha + fb.alpha) / 2 * P.TRAIL_ALPHA * P.INTENSITY; if (alpha < 0.004) continue;
    const wa = Math.max(0.3, a.w * fa.width) / 2, wb = Math.max(0.3, b.w * fb.width) / 2; // narrower where it is older, i.e. behind the drop
    ctx.fillStyle = `rgba(185,210,232,${alpha.toFixed(3)})`;
    ctx.beginPath(); ctx.moveTo(a.x - wa, a.y); ctx.lineTo(a.x + wa, a.y); ctx.lineTo(b.x + wb, b.y); ctx.lineTo(b.x - wb, b.y); ctx.closePath(); ctx.fill();
  }
}

function draw() {
  ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H); // transparent: only the effect itself is painted
  const m = P.MIST * P.INTENSITY, g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `rgba(150,180,205,${(m * 0.4).toFixed(3)})`); g.addColorStop(0.5, 'rgba(150,180,205,0)'); g.addColorStop(1, `rgba(150,180,205,${m.toFixed(3)})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (const b of beads) { const s = sprite(b.r); ctx.globalAlpha = Math.min(1, b.a * P.INTENSITY); ctx.drawImage(s.el, b.x - s.size / 2, b.y - s.size / 2); }
  ctx.globalAlpha = 1;
  for (const t of trails) drawTrail(t);
  ctx.globalAlpha = Math.min(1, P.INTENSITY);
  for (const d of drops) drawBead(ctx, d.x, d.y, d.r * 0.85, d.r * (d.slide && d.burst.moving ? 1.2 : 1));
  ctx.globalAlpha = 1;
}

const settle = () => { for (let i = 0; i < 240; i++) step(1 / 30); draw(); }; // reduced motion: one still frame of an already wet pane

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (document.hidden || t - last < 1000 / P.FPS) return; // paused in a background tab; capped to keep the CPU cost low
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  step(dt); draw();
}

export default {
  name: 'rain',
  start(canvas, { animate = true } = {}) {
    cv = canvas; ctx = cv.getContext('2d'); sprites = new Map(); resize();
    if (!animate) { settle(); return; }
    last = performance.now(); raf = requestAnimationFrame(frame);
  },
  stop() { cancelAnimationFrame(raf); raf = 0; cv = ctx = null; beads = []; drops = []; trails = []; sprites = new Map(); },
  resize() { resize(); if (cv && !raf) settle(); },
};
