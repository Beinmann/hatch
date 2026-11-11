// Pure maths for the goo effect (no canvas, no globals; `rand` is injected so it is unit-tested): a drip grows from a point under a
// text cell as a thin strand with a bead at the tip, hangs and sways, then either recedes or lets go (the bead falls while the strand
// snaps back up and fades). Times are seconds, lengths are canvas px (= CSS px: the canvas runs at device pixel ratio 1).
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (p) => { const t = clamp(p, 0, 1); return t * t * (3 - 2 * t); }; // slow start, quicker middle, slow end: gravity-like growth

// ---- Tuning knobs ----
export const CFG = {
  DENSITY: 26000,          // canvas px^2 per drip at the default intensity (smaller = more drips)
  MIN: 3, MAX: 28,         // bounds on the number of drips at the default intensity (scaled by the intensity factor)
  SPAWN_RATE: 1.6,         // new drips per second while below the cap
  BASELINE: 0.86,          // where in a cell (0 top .. 1 bottom) the strand starts: about the foot of a glyph
  LEN: [26, 130],          // strand length range in px (skewed toward short)
  RUN_P: 0.05,             // chance of a drip that runs the full height of the canvas
  HANG_P: 0.5,             // chance of a drip that hangs for a long time, like a title card, instead of dripping soon
  HOLD_HANG: [9, 26], HOLD_SHORT: [0.4, 3.5], // seconds a drip hangs fully grown
  LET_GO_P: 0.55,          // chance that a drip lets go at the end of its hold (else it recedes)
  GROW_BASE: 3.0, GROW_PER_PX: 1 / 22, // seconds to grow: base plus per px of length
  WIDTH: [1.5, 3.0],       // strand width at the root; the tip is thinner
  TAPER: 0.55,             // how much thinner the strand is at the tip (0 none .. 1 to a point)
  BEAD: [2.2, 4.4],        // bead radius when fully grown
  SWAY_AMP: [1.2, 3.4], SWAY_FREQ: [0.5, 1.1], // sideways wavering in px and rad/s (slow)
  GRAVITY: 520,            // px/s^2 for a falling bead
  RETRACT: 9,              // how fast the strand snaps up after the bead lets go (1/s)
  RECEDE: [2.5, 5],        // seconds a drip takes to shrink back when it does not let go
  FALL_LIMIT: [40, 220],   // px a bead falls before it fades out (some run on to the bottom)
  FALL_FADE: 2.2,          // 1/s fade rate once past the limit
  MAX_FADE_IN: 0.6,        // seconds for a new drip to fade in
};

/** Intensity 0..100 as { count, alpha }: how many drips there are and how strong they are drawn (both 1 at the default 50, count 0 at 0). */
export function gooLevel(n) {
  const f = Number.isFinite(n) ? clamp(n / 50, 0, 2) : 1;
  return { count: f, alpha: f <= 1 ? lerp(0.4, 1, f) : lerp(1, 1.4, f - 1) };
}

/** How many drips a canvas of this size carries: finite and never negative, 0 for an empty canvas or intensity 0. */
export function maxDrips(W, H, level) {
  const area = Math.max(0, num(W)) * Math.max(0, num(H)), c = Math.max(0, num(level?.count, 1));
  if (area <= 0 || c <= 0) return 0;
  return Math.round(clamp(area / CFG.DENSITY, CFG.MIN, CFG.MAX) * c);
}

/** How good a spot a character is for a drip to start from: feet of letters, commas and underscores are best; marks that sit high
 *  (quotes, carets) and box-drawing/block cells (window frames, bars) are poor; blanks are not a spot at all. */
export function anchorWeight(ch) {
  if (!ch || !String(ch).trim()) return 0;
  const c = String(ch);
  if (/^[.,_;]$/.test(c)) return 1.4;
  if (/^['"`^*~°¯‾]$/.test(c)) return 0.15;
  const code = c.codePointAt(0);
  if (code >= 0x2500 && code <= 0x259f) return 0.25;
  return 1;
}

/** Picks one of `cells` ([{col,row,ch}]) at random, preferring good spots; skips cells whose "col,row" key is in `taken`. null if none. */
export function pickAnchor(cells, rand, taken = new Set(), tries = 8) {
  if (!cells?.length) return null;
  let best = null, bestScore = 0;
  for (let i = 0; i < tries; i++) {
    const c = cells[Math.floor(rand() * cells.length) % cells.length];
    if (!c || taken.has(`${c.col},${c.row}`)) continue;
    const score = anchorWeight(c.ch) * (0.3 + rand());
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

/** Pixel origin of a strand hanging from a cell, given { w, h, left, top } and the horizontal spot fx (0..1) inside the cell. */
export const cellOrigin = (cell, size, fx = 0.5) => ({ x: num(size.left) + (cell.col + fx) * num(size.w), y: num(size.top) + (cell.row + CFG.BASELINE) * num(size.h) });

/** A made-up anchor line near the top of the canvas, for when there is no terminal to anchor to. */
export const fallbackOrigin = (W, H, rand) => ({ x: rand() * Math.max(1, num(W, 1)), y: Math.max(1, num(H, 1)) * 0.06 });

/** A new drip hanging from (ox, oy). anchor = { col, row, ch, fx } ties it to a terminal cell (null = fixed point). H = canvas height. */
export function newDrip(ox, oy, H, rand, anchor = null) {
  const r = (a, b) => lerp(a, b, rand());
  const room = Math.max(0, num(H) - num(oy)); // how far down there is canvas
  const runner = rand() < CFG.RUN_P;
  const maxLen = Math.max(4, runner ? room : Math.min(room, lerp(CFG.LEN[0], CFG.LEN[1], Math.pow(rand(), 1.6))));
  const hang = !runner && rand() < CFG.HANG_P;
  return {
    ox: num(ox), oy: num(oy), anchor, phase: 'grow', t: 0, age: 0, len: 0, maxLen,
    growT: CFG.GROW_BASE + maxLen * CFG.GROW_PER_PX * (runner ? 0.5 : 1),
    hold: hang ? r(...CFG.HOLD_HANG) : r(...CFG.HOLD_SHORT),
    lets: runner || rand() < CFG.LET_GO_P,
    width: r(...CFG.WIDTH), beadMax: r(...CFG.BEAD), beadR: 0.6,
    swayAmp: r(...CFG.SWAY_AMP), swayFreq: r(...CFG.SWAY_FREQ), swayPhase: rand() * Math.PI * 2,
    fade: 0, // 0..1, multiplies the alpha
    fallLimit: runner || rand() < 0.12 ? Infinity : r(...CFG.FALL_LIMIT), recedeT: r(...CFG.RECEDE),
    startLen: 0, bx: 0, by: 0, bv: 0, travelled: 0, beadFade: 1, done: false,
  };
}

/** The bead lets go: it starts to fall from the tip while the strand snaps back toward its root. */
export function startFall(d) {
  if (d.phase === 'fall' || d.done) return;
  const tip = tipOf(d);
  d.phase = 'fall'; d.t = 0; d.bx = tip.x; d.by = tip.y; d.bv = 0; d.travelled = 0; d.beadFade = 1;
  if (d.len < 1.5) d.done = true; // nothing worth showing
}

/** The anchor is gone (scrolled away, character erased): hold the last position and let go. */
export function release(d) { if (d.anchor) { d.anchor = null; } startFall(d); }

/** Horizontal sway at fraction u (0 root .. 1 tip) of the strand: nothing at the root, most at the tip, slow, a travelling wave. */
export const swayAt = (d, u) => num(d.swayAmp) * Math.sin(num(d.swayFreq) * num(d.age) + num(d.swayPhase) - 2.4 * u) * u * u * clamp(num(d.len) / 70, 0.25, 1);

/** Where the strand ends (the bead's centre while it hangs). */
export const tipOf = (d) => ({ x: d.ox + swayAt(d, 1), y: d.oy + num(d.len) });

/** Advances one drip by dt seconds (mutates it; sets d.done when it is over). H = canvas height. */
export function stepDrip(d, dt, H) {
  dt = clamp(num(dt), 0, 0.25); if (d.done) return d;
  d.age += dt;
  if (d.phase !== 'fall') d.fade = Math.min(1, d.fade + dt / CFG.MAX_FADE_IN);
  if (d.phase === 'grow') {
    d.t += dt; const p = clamp(d.t / d.growT, 0, 1);
    d.len = d.maxLen * smooth(p); d.beadR = lerp(0.6, d.beadMax, Math.pow(p, 0.7)); // the bead swells while the strand lengthens
    if (p >= 1) { d.phase = 'hang'; d.t = 0; }
  } else if (d.phase === 'hang') {
    d.t += dt; d.len = d.maxLen * (1 + 0.025 * Math.min(1, d.t / Math.max(0.1, d.hold))); // a very slow creep while it hangs
    d.beadR = d.beadMax * (1 + 0.04 * Math.sin(d.age * 1.7));
    if (d.t >= d.hold) { if (d.lets) startFall(d); else { d.phase = 'recede'; d.t = 0; d.startLen = d.len; } }
  } else if (d.phase === 'recede') {
    d.t += dt; const q = clamp(d.t / d.recedeT, 0, 1);
    d.len = d.startLen * (1 - smooth(q)); d.fade = 1 - q;
    if (q >= 1) d.done = true;
  } else if (d.phase === 'fall') {
    d.bv += CFG.GRAVITY * dt; const dy = d.bv * dt; d.by += dy; d.travelled += dy;
    d.len *= Math.exp(-CFG.RETRACT * dt); d.fade = Math.max(0, d.fade - dt * 1.2 * (d.len < 8 ? 2 : 0.6)); // the strand fades as it snaps back
    if (d.travelled > d.fallLimit) d.beadFade = Math.max(0, d.beadFade - dt * CFG.FALL_FADE);
    if (d.by - d.beadMax > num(H) || d.beadFade <= 0) d.beadFade = 0;
    if (d.beadFade <= 0 && (d.len < 0.5 || d.fade <= 0)) d.done = true;
  }
  return d;
}

/** Points along the strand from root to tip for drawing: [{ x, y, w }] (w = width there, tapering). At least 2 points; empty when there is no strand. */
export function strandPoints(d) {
  const len = num(d.len); if (len < 0.5) return [];
  const n = clamp(Math.ceil(len / 6), 2, 40), out = [];
  for (let i = 0; i <= n; i++) { const u = i / n; out.push({ x: d.ox + swayAt(d, u), y: d.oy + len * u, w: Math.max(0.4, d.width * (1 - CFG.TAPER * u)) }); }
  return out;
}

/** The scroll moved the content up by `dRows` rows (negative = down): anchored drips move with their line; one whose cell leaves
 *  rows 0..rows-1 is released. Returns how many were released. Positions come from anchor.row, so nothing else needs shifting. */
export function scrollDrips(drips, dRows, rows) {
  const d0 = Math.trunc(num(dRows)); let n = 0;
  if (!d0) return 0;
  for (const d of drips) {
    if (!d.anchor) continue;
    d.anchor.row -= d0;
    if (d.anchor.row < 0 || d.anchor.row >= rows) { release(d); n++; }
  }
  return n;
}

/** Releases anchored drips whose character is no longer in their cell. charAt(col, row) -> string. Returns how many were released. */
export function checkAnchors(drips, charAt) {
  let n = 0;
  for (const d of drips) if (d.anchor && !d.done && charAt(d.anchor.col, d.anchor.row) !== d.anchor.ch) { release(d); n++; }
  return n;
}

/** Moves anchored drips to their cell's current position (the cell size or the grid's offset may have changed). */
export function placeDrips(drips, size) {
  for (const d of drips) if (d.anchor && d.phase !== 'fall') { const o = cellOrigin(d.anchor, size, d.anchor.fx); d.ox = o.x; d.oy = o.y; }
}
