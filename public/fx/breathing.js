// Breathing: three large saturated glows (blue low left, teal high right, violet in the middle) that clearly swell and fade out of phase. Three radial gradients per frame.
import { makeEffect } from './loop.js';

function glow(ctx, w, h, x, y, r, rgb, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${rgb},1)`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.globalAlpha = Math.min(1, a); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

export default makeEffect('breathing', {
  fps: 20, still: 20,
  create(w, h, level) {
    let T = 0;
    return {
      step(dt) { T += dt; },
      draw(ctx) {
        if (level.count <= 0) return;
        // Three saturated glows swell and fade out of phase (about a 9 s breath); at the default intensity each peaks around 0.4 alpha, still soft enough for text.
        const ph = (o) => 0.5 + 0.5 * Math.sin(T * 0.7 + o), b = ph(0), b2 = ph(2.1), b3 = ph(4.2), m = Math.max(w, h);
        glow(ctx, w, h, w * 0.22, h * 0.82, m * (0.5 + 0.3 * b), '50,110,255', (0.08 + 0.3 * b) * level.alpha);
        glow(ctx, w, h, w * 0.82, h * 0.22, m * (0.45 + 0.3 * b2), '30,230,190', (0.08 + 0.3 * b2) * level.alpha);
        glow(ctx, w, h, w * 0.55, h * 0.5, m * (0.35 + 0.25 * b3), '180,90,255', (0.05 + 0.24 * b3) * level.alpha);
      },
    };
  },
});
