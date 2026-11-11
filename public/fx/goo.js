// Black goo dripping from the terminal text, after the thin dark strands of a certain game's title card: each strand hangs from a letter
// on screen, wavers slightly and ends in a heavier bead; some hang for a long time, some let go (the bead falls, the strand snaps back).
// Drips are anchored to cells of the terminal screen (the `terminal` view from public/fx-terminal.js): they follow their line when the
// buffer scrolls and are released when the character under them goes. Without a terminal they hang from random points near the top.
// Drawn on the canvas UNDER the text, in low alpha: the look is dark oil with a faint lighter rim and a soft highlight, so it still
// shows on a dark terminal. Effect interface (public/fx.js): start(canvas, { animate, intensity, terminal }), setIntensity(n), stop(), resize().
// Behaviour numbers (lengths, timings, counts) are in the CFG table of goo-physics.js; the colours are here.
import { CFG, gooLevel, maxDrips, pickAnchor, cellOrigin, fallbackOrigin, newDrip, stepDrip, strandPoints, tipOf, scrollDrips, checkAnchors, placeDrips, release } from './goo-physics.js';

// ---- Colours (rgb triplets; alpha is applied per drip) ----
export const COLORS = {
  BODY: '12,17,26',        // near-black blue-grey: flat black would vanish on a dark terminal
  BODY_LIGHT: '38,52,70',  // the lighter middle of a bead
  BODY_ALPHA: 0.82,        // opacity of the body
  RIM: '125,155,190',      // thin lighter edge along strand and bead
  RIM_ALPHA: 0.24,
  SPEC: '215,230,245',     // specular highlight on the bead and the moving streak along the strand
  SPEC_ALPHA: 0.5, STREAK_ALPHA: 0.2,
};
const FPS = 30; // frame cap
const TAU = Math.PI * 2;
const rgba = (c, a) => `rgba(${c},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

let cv = null, ctx = null, raf = 0, last = 0, W = 1, H = 1, drips = [], term = null, off = null, level = gooLevel(50), size = null, lastVy = 0, cells = null, animating = true;

const hasText = () => term && term.cols > 0 && term.rows > 0;
function measure() { try { const s = term?.cellSize(); size = s && s.w > 0 && s.h > 0 ? s : null; } catch { size = null; } }

function spawn() {
  if (!term) { const o = fallbackOrigin(W, H, Math.random); drips.push(newDrip(o.x, o.y, H, Math.random)); return; }
  if (!size) return; // not measurable yet (terminal still opening)
  if (!cells) { try { cells = term.cellsWithText(); } catch { cells = []; } }
  const taken = new Set(drips.filter((d) => d.anchor).map((d) => `${d.anchor.col},${d.anchor.row}`));
  const c = pickAnchor(cells, Math.random, taken); if (!c) return;
  const fx = 0.25 + Math.random() * 0.5, o = cellOrigin(c, size, fx);
  if (o.y >= H) return;
  drips.push(newDrip(o.x, o.y, H, Math.random, { col: c.col, row: c.row, ch: c.ch, fx }));
}

/** Screen changed (rendered, scrolled, resized): follow the scroll, let go of drips whose letter is gone. Throttled by the terminal view. */
function refresh() {
  if (!cv || !term) return;
  measure(); cells = null;
  try {
    const vy = term.viewportY();
    if (vy !== lastVy) { scrollDrips(drips, vy - lastVy, term.rows); lastVy = vy; }
    checkAnchors(drips, (c, r) => term.charAt(c, r));
  } catch { for (const d of drips) release(d); } // the terminal went away under us: let everything fall
  if (size) placeDrips(drips, size);
}

function step(dt) {
  for (const d of drips) stepDrip(d, dt, H);
  drips = drips.filter((d) => !d.done);
  if (term && !size) measure();
  const want = maxDrips(W, H, level);
  if (drips.filter((d) => d.phase !== 'fall').length < want && Math.random() < dt * CFG.SPAWN_RATE * Math.max(0.3, level.count)) spawn();
}

function drawStrand(d, a) {
  const p = strandPoints(d); if (p.length < 2) return;
  ctx.fillStyle = rgba(COLORS.BODY, COLORS.BODY_ALPHA * a);
  ctx.beginPath(); ctx.moveTo(p[0].x - p[0].w / 2, p[0].y);
  for (const q of p) ctx.lineTo(q.x - q.w / 2, q.y);
  for (let i = p.length - 1; i >= 0; i--) ctx.lineTo(p[i].x + p[i].w / 2, p[i].y);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = rgba(COLORS.RIM, COLORS.RIM_ALPHA * a); ctx.lineWidth = 0.6; // rim along both edges
  ctx.beginPath(); ctx.moveTo(p[0].x - p[0].w / 2, p[0].y); for (const q of p) ctx.lineTo(q.x - q.w / 2, q.y);
  ctx.moveTo(p[0].x + p[0].w / 2, p[0].y); for (const q of p) ctx.lineTo(q.x + q.w / 2, q.y); ctx.stroke();
  // a faint highlight streak that slides down one side of the strand
  const u0 = ((d.age * 0.14 + d.swayPhase) % 1) * 0.85, i0 = Math.floor(u0 * (p.length - 1)), i1 = Math.min(p.length - 1, i0 + Math.max(1, Math.ceil(p.length * 0.25)));
  ctx.strokeStyle = rgba(COLORS.SPEC, COLORS.STREAK_ALPHA * a); ctx.lineWidth = 0.8;
  ctx.beginPath(); for (let i = i0; i <= i1; i++) { const q = p[i]; if (i === i0) ctx.moveTo(q.x + q.w * 0.22, q.y); else ctx.lineTo(q.x + q.w * 0.22, q.y); } ctx.stroke();
}

function drawBead(x, y, r, stretch, a) {
  if (!(r > 0) || !(a > 0) || !Number.isFinite(x + y)) return;
  const rx = r * 0.95, ry = r * 1.2 * stretch;
  const g = ctx.createRadialGradient(x - rx * 0.2, y - ry * 0.2, rx * 0.1, x, y, Math.max(rx, ry));
  g.addColorStop(0, rgba(COLORS.BODY_LIGHT, COLORS.BODY_ALPHA * a)); g.addColorStop(1, rgba(COLORS.BODY, COLORS.BODY_ALPHA * a));
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = rgba(COLORS.RIM, COLORS.RIM_ALPHA * a); ctx.lineWidth = Math.max(0.5, rx * 0.15);
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.stroke();
  const hx = x - rx * 0.4, hy = y - ry * 0.4, hr = Math.max(0.5, rx * 0.4);
  const h = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr); h.addColorStop(0, rgba(COLORS.SPEC, COLORS.SPEC_ALPHA * a)); h.addColorStop(1, rgba(COLORS.SPEC, 0));
  ctx.fillStyle = h; ctx.beginPath(); ctx.arc(hx, hy, hr, 0, TAU); ctx.fill();
}

function draw() {
  ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H); // transparent where nothing hangs
  for (const d of drips) {
    const a = d.fade * level.alpha;
    if (d.phase === 'fall') {
      drawStrand(d, a);
      drawBead(d.bx, d.by, d.beadMax, 1 + Math.min(0.9, d.bv / 380), d.beadFade * level.alpha); // a falling drop stretches
    } else { drawStrand(d, a); const t = tipOf(d); drawBead(t.x, t.y, d.beadR, 1, a); }
  }
}

function resize() {
  if (!cv) return;
  W = cv.width = Math.max(1, cv.clientWidth); H = cv.height = Math.max(1, cv.clientHeight);
  if (term) { measure(); cells = null; if (size) placeDrips(drips, size); }
  drips = drips.filter((d) => d.oy < H);
}

const settle = () => { for (let i = 0; i < 360; i++) step(1 / 30); draw(); }; // reduced motion: one still frame of drips mid-hang

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (document.hidden || t - last < 1000 / FPS) return; // paused in a background tab; capped to keep the CPU cost low
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  step(dt); draw();
}

export default {
  name: 'goo',
  start(canvas, { animate = true, intensity, terminal = null } = {}) {
    cv = canvas; ctx = cv.getContext('2d'); level = gooLevel(intensity); drips = []; cells = null; animating = animate;
    term = terminal && typeof terminal.cellsWithText === 'function' ? terminal : null;
    resize();
    if (term) { try { lastVy = term.viewportY(); } catch { lastVy = 0; } off = term.onChange?.(refresh) || null; }
    if (!animate) { settle(); return; }
    last = performance.now(); raf = requestAnimationFrame(frame);
  },
  setIntensity(n) { level = gooLevel(n); if (cv && !raf) settle(); },
  stop() { cancelAnimationFrame(raf); raf = 0; try { off?.(); } catch { /* ignore */ } off = null; cv = ctx = term = null; drips = []; cells = null; },
  resize() { resize(); if (cv && !raf) settle(); },
};
