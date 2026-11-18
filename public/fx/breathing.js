// Breathing: two large soft glows (blue low left, teal high right) that swell and fade out of phase. Two radial gradients per frame.
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
        const b = 0.5 + 0.5 * Math.sin(T * 0.5), b2 = 0.5 + 0.5 * Math.sin(T * 0.5 + 2.4), m = Math.max(w, h);
        glow(ctx, w, h, w * 0.25, h * 0.8, m * (0.55 + 0.12 * b), '60,120,230', (0.05 + 0.07 * b) * level.alpha);
        glow(ctx, w, h, w * 0.8, h * 0.25, m * (0.5 + 0.12 * b2), '60,220,190', (0.05 + 0.07 * b2) * level.alpha);
      },
    };
  },
});
