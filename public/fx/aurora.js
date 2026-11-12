// Aurora: slow curtains of green and teal (one violet) hang from a wavy line in the upper part of the screen and fade downward into
// nothing. Drawn as vertical strips whose length and brightness follow slow sine waves, so it is a few hundred cheap rects per frame.
import { makeEffect } from './loop.js';

const BANDS = [ // hue as rgb, base height as a fraction of the canvas, speed, wavelength scale
  { rgb: '60,255,150', y: 0.22, hgt: 0.34, sp: 0.11, k: 1.0, a: 0.30 },
  { rgb: '40,220,210', y: 0.30, hgt: 0.30, sp: -0.08, k: 1.7, a: 0.22 },
  { rgb: '170,110,255', y: 0.17, hgt: 0.22, sp: 0.06, k: 2.4, a: 0.16 },
];
const STRIP = 6;

export default makeEffect('aurora', {
  fps: 24, still: 60,
  create(w, h, level) {
    const n = Math.ceil(w / STRIP) + 1; let T = Math.random() * 100, grads = null;
    // One unit-height gradient per band, made on the first draw; each strip is drawn under a transform that stretches it to its own length.
    const makeGrads = (ctx) => BANDS.map((b) => { const g = ctx.createLinearGradient(0, 0, 0, 1); g.addColorStop(0, `rgba(${b.rgb},0)`); g.addColorStop(0.12, `rgba(${b.rgb},1)`); g.addColorStop(1, `rgba(${b.rgb},0)`); return g; });
    return {
      step(dt) { T += dt; },
      draw(ctx) {
        if (level.count <= 0) return;
        grads ||= makeGrads(ctx);
        BANDS.forEach((b, bi) => {
          for (let i = 0; i < n; i++) {
            const u = (i * STRIP) / Math.max(1, w), p = u * 6.28 * b.k;
            const wob = Math.sin(p + T * b.sp * 6) + 0.5 * Math.sin(p * 2.3 - T * b.sp * 4);
            const top = h * (b.y + 0.05 * wob);
            const glow = Math.max(0, 0.55 + 0.45 * Math.sin(p * 1.9 + T * b.sp * 9 + 1.7) * Math.sin(p * 0.6 - T * 0.2)); // brighter and darker stretches
            const len = h * b.hgt * (0.6 + 0.4 * glow);
            ctx.setTransform(1, 0, 0, Math.max(1, len), 0, top);
            ctx.globalAlpha = Math.min(1, b.a * glow * level.alpha); ctx.fillStyle = grads[bi]; ctx.fillRect(i * STRIP, 0, STRIP, 1);
          }
        });
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      },
    };
  },
});
