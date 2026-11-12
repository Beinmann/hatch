// Fireflies: a few dozen warm yellow-green points wander slowly on smooth curves and pulse, each with a soft halo (three stacked
// translucent circles: no gradients, no blur).
import { makeEffect, countFor, rnd } from './loop.js';
const TAU = Math.PI * 2;

export default makeEffect('fireflies', {
  still: 90,
  create(w, h, level) {
    const flies = Array.from({ length: countFor(w, h, 26000, level, 80) }, () => ({
      x: rnd(0, w), y: rnd(0, h), dir: rnd(0, TAU), turn: 0, sp: rnd(8, 22), pulse: rnd(0.25, 0.7), ph: rnd(0, TAU), r: rnd(1.2, 2),
    }));
    let T = 0;
    return {
      step(dt) {
        T += dt;
        for (const f of flies) {
          f.turn += (Math.random() - 0.5) * 4 * dt - f.turn * 1.5 * dt; f.dir += f.turn * dt; // a gently wandering heading
          f.x += Math.cos(f.dir) * f.sp * dt; f.y += Math.sin(f.dir) * f.sp * dt * 0.7;
          if (f.x < -10) f.x = w + 10; else if (f.x > w + 10) f.x = -10;
          if (f.y < -10) f.y = h + 10; else if (f.y > h + 10) f.y = -10;
        }
      },
      draw(ctx) {
        for (const f of flies) {
          const s = Math.max(0, Math.sin(T * f.pulse * TAU + f.ph)); const g = s * s * s; // mostly dim, a slow bright pulse
          const a = Math.min(1, (0.12 + 0.88 * g) * level.alpha); if (a < 0.03) continue;
          ctx.fillStyle = '#d6ff6a';
          ctx.globalAlpha = a * 0.1; ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 7, 0, TAU); ctx.fill();
          ctx.globalAlpha = a * 0.22; ctx.beginPath(); ctx.arc(f.x, f.y, f.r * 3.4, 0, TAU); ctx.fill();
          ctx.globalAlpha = a * 0.85; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.fill();
        }
      },
    };
  },
});
