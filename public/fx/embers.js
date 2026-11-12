// Embers: sparks rise from the bottom edge, drift sideways on a slow wobble, flicker and cool from orange to dim red as they shrink.
import { makeEffect, countFor, rnd } from './loop.js';
const TAU = Math.PI * 2;

export default makeEffect('embers', {
  still: 150,
  create(w, h, level) {
    const spawn = (f, anywhere) => Object.assign(f, {
      x: rnd(0, w), y: anywhere ? rnd(0, h) : h + 4, r: rnd(1, 2.6), vy: rnd(35, 95), ph: rnd(0, TAU), wob: rnd(6, 22), fr: rnd(0.5, 1.4), life: anywhere ? Math.random() : 0, span: rnd(0.09, 0.2),
    });
    const list = Array.from({ length: countFor(w, h, 4500, level, 300) }, () => spawn({}, true));
    let T = 0;
    return {
      step(dt) { T += dt; for (const f of list) { f.y -= f.vy * dt; f.life += f.span * dt; if (f.life >= 1 || f.y < -6) spawn(f, false); } },
      draw(ctx) {
        for (const f of list) {
          const k = 1 - f.life, flick = 0.75 + 0.25 * Math.sin(T * 9 * f.fr + f.ph);
          const x = f.x + f.wob * Math.sin(T * f.fr + f.ph) * (1 - k * 0.3);
          ctx.fillStyle = k > 0.55 ? '#ffb347' : k > 0.25 ? '#ff7a2f' : '#c9361f';
          ctx.globalAlpha = Math.min(1, k * flick * level.alpha); ctx.beginPath(); ctx.arc(x, f.y, f.r * (0.5 + 0.5 * k), 0, TAU); ctx.fill();
        }
      },
    };
  },
});
