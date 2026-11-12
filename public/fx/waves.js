// Waves: four translucent swells of blue-teal along the bottom of the screen, each a sum of two slow sines, drifting at their own speed.
// Each layer is one filled path (a point every 12 px) plus a thin crest line.
import { makeEffect } from './loop.js';

const LAYERS = [ // base height (fraction of the canvas from the bottom), amplitude px, wavelength px, speed, rgb, alpha
  { base: 0.16, amp: 16, wl: 520, sp: 0.25, rgb: '40,130,200', a: 0.10 },
  { base: 0.12, amp: 13, wl: 380, sp: -0.32, rgb: '40,170,190', a: 0.10 },
  { base: 0.08, amp: 10, wl: 270, sp: 0.4, rgb: '60,200,210', a: 0.11 },
  { base: 0.04, amp: 7, wl: 190, sp: -0.5, rgb: '120,220,235', a: 0.12 },
];
const STEP = 12;

export default makeEffect('waves', {
  fps: 30, still: 30,
  create(w, h, level) {
    let T = 0; const n = Math.ceil(w / STEP) + 1;
    return {
      step(dt) { T += dt; },
      draw(ctx) {
        if (level.count <= 0) return;
        for (const L of LAYERS) {
          const y0 = h * (1 - L.base), k = 6.2832 / L.wl, ph = T * L.sp * 6.2832;
          ctx.beginPath(); ctx.moveTo(0, h);
          for (let i = 0; i < n; i++) { const x = i * STEP; ctx.lineTo(x, y0 - L.amp * (Math.sin(x * k + ph) + 0.45 * Math.sin(x * k * 2.1 - ph * 1.3 + 1))); }
          ctx.lineTo(w + STEP, h); ctx.closePath();
          ctx.fillStyle = `rgba(${L.rgb},1)`; ctx.globalAlpha = Math.min(1, L.a * level.alpha); ctx.fill();
          ctx.strokeStyle = `rgba(${L.rgb},1)`; ctx.lineWidth = 1; ctx.globalAlpha = Math.min(1, L.a * 2.2 * level.alpha); ctx.stroke();
        }
      },
    };
  },
});
