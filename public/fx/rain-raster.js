// Draws the glass into a "water map" (RGBA bytes, one pixel per canvas pixel) on the CPU: R,G = surface normal of the drop at that pixel
// (0.5 = flat), B = the drop's radius in px / SIZE_MAX (how strong a lens it is), A = how much water is there (0 = dry glass, which also
// anti-aliases the edge). The WebGL shader turns the map into refraction and light; the 2D fallback does not use it. Pure: no DOM.
import { clamp } from './rain-physics.js';

export const SIZE_MAX = 24;
const put = (buf, i, nx, ny, size, a) => { // the more watery pixel wins where drops overlap
  if (a <= buf[i + 3]) return;
  buf[i] = (nx * 0.5 + 0.5) * 255; buf[i + 1] = (ny * 0.5 + 0.5) * 255; buf[i + 2] = Math.min(255, (size / SIZE_MAX) * 255); buf[i + 3] = a;
};

/** Water-map value of drop `d` at canvas pixel centre (px, py): { nx, ny, cov } or null when outside. `r` is the drawn radius. Exposed for tests. */
export function dropAt(d, r, px, py) {
  const s = (px - d.x) / r, t = (py - d.y) / r, L = d.tail || 0;
  const hy = t < 0 ? d.sy * (1 + L) : d.sy, u = t < 0 ? clamp(-t / hy, 0, 1) : 0;
  const wx = d.sx * (1 - Math.min(0.6, L * 0.7) * u);
  let a = s / wx, b = t / hy, m = 1;
  if (a * a + b * b > 1.8) return null; // far outside: skip the angle maths
  if (d.wob) { const th = Math.atan2(b, a); for (const w of d.wob) m += w.a * Math.cos(w.k * th + w.p); m = clamp(m, 0.7, 1.3); }
  a /= m; b /= m;
  const f = Math.hypot(a, b), cov = clamp((1 - f) * r * Math.min(d.sx, d.sy) + 0.5, 0, 1);
  if (cov <= 0) return null;
  const k = f > 1 ? 1 / f : 1;
  return { nx: a * k, ny: b * k, cov };
}

export function stampDrop(buf, W, H, d, look) {
  const r = d.r * look.scale; if (!(r > 0.3) || !(look.alpha > 0.004)) return;
  const L = d.tail || 0, reach = 1.35 * r, up = reach * d.sy * (1 + L), dn = reach * d.sy, sx = reach * d.sx;
  const x0 = Math.max(0, Math.floor(d.x - sx - 1)), x1 = Math.min(W - 1, Math.ceil(d.x + sx + 1));
  const y0 = Math.max(0, Math.floor(d.y - up - 1)), y1 = Math.min(H - 1, Math.ceil(d.y + dn + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = dropAt(d, r, x + 0.5, y + 0.5); if (!v) continue;
      put(buf, (y * W + x) * 4, v.nx, v.ny, r, Math.round(v.cov * look.alpha * 255));
    }
  }
}

/** A thin wet streak between two trail points: a flat, faint lens across its width. */
export function stampSegment(buf, W, H, a, b, wa, wb, alpha) {
  if (!(alpha > 0.01)) return;
  const hw = Math.max(wa, wb) / 2 + 1, x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - hw)), x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x) + hw));
  const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - hw)), y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y) + hw));
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = clamp(((x + 0.5 - a.x) * dx + (y + 0.5 - a.y) * dy) / len2, 0, 1), cx = a.x + dx * t, cy = a.y + dy * t, w = (wa + (wb - wa) * t) / 2;
      const off = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), cov = clamp(w - off + 0.5, 0, 1); if (cov <= 0) continue;
      const side = (x + 0.5 - cx) / Math.max(0.5, w);
      put(buf, (y * W + x) * 4, clamp(side, -1, 1) * 0.7, 0, w, Math.round(cov * alpha * 255));
    }
  }
}

/** The resting glass: finished trails first (they are under the drops), then every drop that is not running. The running drop is left out
 *  so this can be redone rarely; see rasterLive. */
export function rasterStatic(buf, W, H, glass) {
  buf.fill(0);
  for (const t of glass.trails) if (t !== glass.runner?.run?.trail) stampTrail(buf, W, H, t, glass);
  for (const d of glass.drops) if (!d.run) stampDrop(buf, W, H, d, glass.look(d));
}

/** `buf` = the static map plus the running drop and its trail, which change every frame. */
export function rasterLive(buf, base, W, H, glass) {
  buf.set(base);
  const d = glass.runner; if (!d) return;
  if (d.run.trail) stampTrail(buf, W, H, d.run.trail, glass);
  stampDrop(buf, W, H, d, glass.look(d));
}

function stampTrail(buf, W, H, t, glass) {
  for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1], b = t.pts[i], fa = glass.trailFade(a), fb = glass.trailFade(b);
    stampSegment(buf, W, H, a, b, a.w * fa.width, b.w * fb.width, ((fa.alpha + fb.alpha) / 2) * 0.85);
  }
}

/** The whole glass in one go (tests, still frames). */
export function rasterize(buf, W, H, glass) { rasterStatic(buf, W, H, glass); rasterLive(buf, buf.slice(), W, H, glass); }
