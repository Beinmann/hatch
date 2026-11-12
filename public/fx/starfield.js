// Starfield: stars in three depth layers drift slowly sideways (nearer ones faster) and twinkle; a few are warm or blue-tinted.
import { makeEffect, countFor, rnd } from './loop.js';
const TAU = Math.PI * 2;
const TINTS = ['#ffffff', '#ffffff', '#cfe0ff', '#ffe9c4'];

export default makeEffect('starfield', {
  fps: 24,
  create(w, h, level) {
    const stars = Array.from({ length: countFor(w, h, 3200, level, 700) }, () => {
      const z = Math.random(); // 0 far .. 1 near
      return { x: rnd(0, w), y: rnd(0, h), z, r: 0.5 + z * 1.2, v: 1.5 + z * 9, tw: rnd(0.4, 1.6), ph: rnd(0, TAU), c: TINTS[Math.floor(Math.random() * TINTS.length)] };
    });
    let T = 0;
    return {
      step(dt) { T += dt; for (const s of stars) { s.x -= s.v * dt; if (s.x < -2) s.x += w + 4; } },
      draw(ctx) {
        for (const s of stars) {
          const tw = 0.6 + 0.4 * Math.sin(T * s.tw + s.ph);
          ctx.globalAlpha = Math.min(1, (0.25 + 0.6 * s.z) * tw * level.alpha); ctx.fillStyle = s.c;
          if (s.r < 1) ctx.fillRect(s.x, s.y, 1, 1); else { ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.fill(); }
        }
      },
    };
  },
});
