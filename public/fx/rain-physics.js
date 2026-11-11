// Pure helpers for the rain-on-glass effect: no canvas, no globals, `rand` is injected where randomness is needed, so they are unit-tested.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
export { clamp, num };

/** Radius after two drops merge: area is conserved (r^2 adds up). */
export const mergeRadius = (a, b) => Math.hypot(num(a), num(b));

/** Does the sliding drop `d` wipe the resting drop `b`? `reach` < 1 shrinks the resting drop's share of the contact distance. */
export function touches(d, b, reach = 0.6) {
  const dx = b.x - d.x, dy = b.y - d.y, s = d.r + b.r * reach;
  return dx * dx + dy * dy < s * s;
}

/** Radius of a new resting drop: many tiny ones, some medium, a few large (as on a real pane). rand() in [0,1). */
export function sampleRadius(rand, { tiny = [0.7, 2.1], mid = [2.2, 6], big = [6, 14] } = {}) {
  const u = rand(), pick = u < 0.62 ? tiny : u < 0.92 ? mid : big, v = rand();
  return pick[0] + (pick[1] - pick[0]) * v * v; // skewed to the small end of each band
}

/** Shape of a resting drop. sx/sy stretch the circle (water on glass is a little flattened), `tail` is a short point on the upper side
 *  (0 = round), `wob` are three low harmonics that make the outline irregular, so drops are not just circles. */
export function sampleShape(rand, r) {
  const big = clamp(r / 6, 0, 1), sx = 0.88 + rand() * 0.3, round = rand() < 0.45;
  return {
    sx, sy: 1 / Math.sqrt(sx) * (0.9 + rand() * 0.1), tail: round ? 0 : rand() * (0.15 + 0.5 * big),
    wob: [2, 3, 5].map((k) => ({ k, a: (rand() - 0.5) * (0.05 + 0.13 * big) * (k === 2 ? 1.5 : k === 5 ? 0.6 : 1), p: rand() * Math.PI * 2 })),
  };
}

/** Current look of a drop at `age` seconds: it condenses in over `appear` s, then evaporates: its radius shrinks steadily over its whole life
 *  (down to `shrink` of full size at the end) and it only fades in the last `fade` share of its life, gently. Returns { alpha, scale }
 *  (scale 0..1 of its radius) and whether it is gone. */
export function dropLook(age, life, { appear = 2.5, fade = 0.2, shrink = 0.3 } = {}) {
  const a = num(age), grow = clamp(a / appear, 0, 1), f = life > 0 ? clamp(a / life, 0, 1) : 1;
  const out = f > 1 - fade ? (f - (1 - fade)) / fade : 0;
  return { alpha: grow * (1 - out * out * (3 - 2 * out)), scale: (0.35 + 0.65 * grow) * (1 - (1 - shrink) * f), dead: a >= life };
}

/** Sideways offset (px) of a running drop after it has travelled `dist` px: a slow lean plus a small wobble, so the track is not a ruler line.
 *  `seed` (a random number 0..1 chosen per drop) varies it. Starts at 0 and is smooth. */
export function wavyOffset(dist, seed, amp = 5) {
  const d = Math.max(0, num(dist)), s = num(seed) * 6.28;
  return amp * (Math.sin(d / 23 + s) - Math.sin(s)) + amp * 0.35 * (Math.sin(d / 9 + s * 2.3) - Math.sin(s * 2.3)) + (seed - 0.5) * d * 0.05;
}

/** Speed (px/s) of a running drop with radius r after `frac` (0..1) of its run: quick start, slowing to a stop at the end. */
export function runSpeed(r, frac, speed = 1) {
  const f = clamp(num(frac), 0, 1), ease = f < 0.85 ? 1 : Math.max(0.05, (1 - f) / 0.15);
  return (28 + 11 * Math.max(0, num(r))) * speed * ease;
}

/** Wet trail fade by age: alpha and width multipliers (1 fresh, 0 gone) and whether the point is dead. The trail narrows as it dries. */
export function trailFade(age, life) {
  const t = life > 0 ? clamp(num(age) / life, 0, 1) : 1;
  return { alpha: Math.pow(1 - t, 1.5), width: 1 - 0.6 * t, dead: t >= 1 };
}

/** How many resting drops a canvas of this size should carry: one per `density` px^2, between 0 and `max` (finite for any size, including 0). */
export const dropTarget = (W, H, density, max) => clamp(Math.floor(Math.max(0, num(W)) * Math.max(0, num(H)) / Math.max(1, density)), 0, max);

/** Intensity 0..100 as { alpha, count }: a multiplier on every alpha and one on how many drops there are (both 1 at the default 50). */
export const rainLevel = (n) => { const f = Number.isFinite(n) ? clamp(n / 50, 0, 2) : 1; return { alpha: f, count: f }; };

/** Where the page background image lands, as the mapping from a canvas pixel to texture coordinates (0..1): uv = px * s + o.
 *  Mirrors the CSS body background (position center, attachment fixed = relative to the viewport): `mode` is fill (cover), fit (contain),
 *  stretch, center, or tile. (cx, cy) is the canvas' top-left in the viewport. Returns { sx, sy, ox, oy }. Bad sizes give the identity. */
export function bgTransform(mode, imgW, imgH, vw, vh, cx = 0, cy = 0) {
  if (!(imgW > 0 && imgH > 0 && vw > 0 && vh > 0)) return { sx: 1, sy: 1, ox: 0, oy: 0 };
  let w = vw, h = vh; // drawn size of the image in CSS px
  if (mode === 'fit') { const k = Math.min(vw / imgW, vh / imgH); w = imgW * k; h = imgH * k; }
  else if (mode === 'center' || mode === 'tile') { w = imgW; h = imgH; }
  else if (mode !== 'stretch') { const k = Math.max(vw / imgW, vh / imgH); w = imgW * k; h = imgH * k; } // fill
  const left = mode === 'tile' ? 0 : (vw - w) / 2, top = mode === 'tile' ? 0 : (vh - h) / 2;
  return { sx: 1 / w, sy: 1 / h, ox: (cx - left) / w, oy: (cy - top) / h };
}

/** Parses a computed CSS colour (rgb(), rgba(), color(srgb ...), or #hex) to [r,g,b,a] in 0..1, or `fallback` when it is not understood. */
export function parseCssColor(s, fallback = [0.07, 0.08, 0.1, 0.7]) {
  const str = String(s || '').trim(), nums = (t) => t.match(/-?\d*\.?\d+(?:e-?\d+)?%?/gi) || [];
  let m;
  if ((m = /^rgba?\((.*)\)$/i.exec(str))) { const v = nums(m[1]); if (v.length >= 3) return [0, 1, 2].map((i) => clamp(parseFloat(v[i]) / 255, 0, 1)).concat(v[3] === undefined ? 1 : clamp(parseFloat(v[3]) / (v[3].endsWith('%') ? 100 : 1), 0, 1)); }
  if ((m = /^color\(\s*(?:srgb|display-p3)\s+(.*)\)$/i.exec(str))) { const v = nums(m[1]); if (v.length >= 3) return [0, 1, 2].map((i) => clamp(parseFloat(v[i]), 0, 1)).concat(v[3] === undefined ? 1 : clamp(parseFloat(v[3]) / (v[3].endsWith('%') ? 100 : 1), 0, 1)); }
  if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str))) { const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1); }
  return fallback;
}

/** The faint background rain behind the glass. Streaks are thin and fall from the upper right toward the lower left, `angleDeg` off
 *  vertical. `width` is the half-width in px of the lit line (kept small: the blur must never make a streak look thick), `weight` its
 *  strength, `max` caps the summed brightness where lanes overlap. The shader (rain-shader.js) is built from this table. */
export const STREAKS = {
  angleDeg: 15,
  max: 0.7,
  families: [ // cell = lane spacing px, width = half-width px, len = px per streak period, speed = periods per second
    { cell: 41, width: 2.3, len: 190, speed: 1.5, seed: 1, weight: 0.7 },
    { cell: 67, width: 3.4, len: 260, speed: 1.1, seed: 2, weight: 0.75 },
    { cell: 29, width: 1.8, len: 140, speed: 2.0, seed: 3, weight: 0.6 },
  ],
};

/** Unit vectors for the streak slant: `along` is the direction the rain moves on screen (y points down, so x < 0 and y > 0 means it
 *  moves down and to the left), `across` is perpendicular to it. */
export function streakAxes(angleDeg = STREAKS.angleDeg) {
  const a = num(angleDeg) * Math.PI / 180;
  return { along: [-Math.sin(a), Math.cos(a)], across: [Math.cos(a), Math.sin(a)] };
}
