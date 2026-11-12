// Calm snowfall: soft white flakes of mixed sizes drift down with a slow sideways sway; big ones are nearer, so they fall faster and
// are brighter. Effect interface: see loop.js.
import { makeEffect, countFor, rnd } from './loop.js';
const TAU = Math.PI * 2;

export default makeEffect('snow', {
  still: 200,
  create(w, h, level) {
    const flakes = Array.from({ length: countFor(w, h, 5000, level, 500) }, () => {
      const near = Math.random() ** 2; // most flakes are far (small, slow, faint)
      return { x: rnd(0, w), y: rnd(0, h), r: 0.7 + near * 2.4, vy: 14 + near * 38, sway: rnd(4, 18), freq: rnd(0.3, 0.9), ph: rnd(0, TAU), a: 0.25 + near * 0.5 };
    });
    let T = 0;
    return {
      step(dt) {
        T += dt;
        for (const f of flakes) { f.y += f.vy * dt; if (f.y - f.r > h) { f.y = -f.r; f.x = rnd(0, w); } }
      },
      draw(ctx) {
        ctx.fillStyle = '#e8f1ff';
        for (const f of flakes) {
          ctx.globalAlpha = Math.min(1, f.a * level.alpha);
          const x = f.x + f.sway * Math.sin(T * f.freq + f.ph);
          if (f.r < 1.3) ctx.fillRect(x, f.y, f.r * 1.6, f.r * 1.6); else { ctx.beginPath(); ctx.arc(x, f.y, f.r, 0, TAU); ctx.fill(); }
        }
      },
    };
  },
});
