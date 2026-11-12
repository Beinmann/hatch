// Shared frame loop for the small 2D effects (snow, stars, aurora, fireflies, embers, waves). An effect module is just
//   export default makeEffect('name', { fps, create(w, h, level) -> { step(dt), draw(ctx) } })
// and this file does the rest of the effect interface (public/fx.js): start(canvas, { animate, intensity }), setIntensity(n), stop(), resize().
// It paints on a transparent canvas (device pixel ratio 1 on purpose: cheap), pauses in a hidden tab, caps the frame rate, and with
// reduced motion (animate: false) it draws one still frame. The canvas never takes input (the page styles it pointer-events: none).
import { factor } from './intensity.js';

export const lerp = (a, b, t) => a + (b - a) * t;
export const rnd = (a, b) => a + Math.random() * (b - a);
/** Intensity 0..100 as { count, alpha }: how many things there are and how strongly they are drawn (both 1 at the default 50, count 0 at 0). */
export function levelOf(n) { const f = factor(n); return { count: f, alpha: f <= 1 ? lerp(0.4, 1, f) : lerp(1, 1.4, f - 1) }; }
/** How many particles a w x h canvas holds: `per` px^2 each at the default intensity, scaled by the level, capped at `max`. Never NaN or negative. */
export function countFor(w, h, per, level, max = 600) {
  const a = Math.max(0, w) * Math.max(0, h), c = Math.max(0, level?.count ?? 1);
  return a > 0 && per > 0 ? Math.min(max, Math.round((a / per) * c)) : 0;
}

export function makeEffect(name, { fps = 30, still = 120, create }) {
  let cv = null, ctx = null, raf = 0, last = 0, W = 1, H = 1, level = levelOf(50), sim = null;
  const build = () => { sim = create(W, H, level); };
  const settle = () => { if (!sim) return; for (let i = 0; i < still; i++) sim.step(1 / 30); paint(); };
  function paint() { ctx.globalAlpha = 1; ctx.clearRect(0, 0, W, H); sim.draw(ctx); ctx.globalAlpha = 1; }
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || t - last < 1000 / fps) return; // paused in a background tab; capped to keep the CPU cost low
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    sim.step(dt); paint();
  }
  return {
    name,
    start(canvas, { animate = true, intensity } = {}) {
      cv = canvas; ctx = cv.getContext('2d'); level = levelOf(intensity); W = cv.width = Math.max(1, cv.clientWidth); H = cv.height = Math.max(1, cv.clientHeight); build();
      if (!animate) { settle(); return; }
      last = performance.now(); raf = requestAnimationFrame(frame);
    },
    setIntensity(n) { level = levelOf(n); if (!cv) return; build(); if (!raf) settle(); },
    stop() { cancelAnimationFrame(raf); raf = 0; cv = ctx = sim = null; },
    resize() { if (!cv) return; W = cv.width = Math.max(1, cv.clientWidth); H = cv.height = Math.max(1, cv.clientHeight); build(); if (!raf) settle(); },
  };
}
