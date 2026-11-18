// Ripples: soft rings spread from random drops, and from clicks on the terminal. The canvas ignores input (pointer-events: none), so while
// the effect runs a passive window-level pointerdown listener only reads the coordinates; it never stops or changes the event, so terminal
// selection and typing are untouched. The listener is removed in stop().
import { makeEffect, rnd } from './loop.js';
const TAU = Math.PI * 2, LIFE = 3.2, MAX = 30;
let drop = null; // set by the running simulation: (x, y) in canvas pixels

const base = makeEffect('ripples', {
  fps: 30, still: 20,
  create(w, h, level) {
    const rings = []; let acc = 0;
    drop = (x, y) => { rings.push({ x, y, t: 0, big: 1 }); if (rings.length > MAX) rings.shift(); };
    return {
      step(dt) {
        acc += dt * level.count;
        if (acc > 1.6) { acc = 0; rings.push({ x: rnd(0.1, 0.9) * w, y: rnd(0.1, 0.9) * h, t: 0, big: 0.55 }); }
        for (const r of rings) r.t += dt;
        for (let i = rings.length - 1; i >= 0; i--) if (rings[i].t > LIFE) rings.splice(i, 1);
        if (rings.length > MAX) rings.splice(0, rings.length - MAX);
      },
      draw(ctx) {
        if (level.count <= 0) return;
        ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgb(110,215,230)';
        for (const r of rings) {
          const p = r.t / LIFE, e = 1 - (1 - p) * (1 - p), a = (1 - p) * (1 - p) * 0.3 * r.big * level.alpha;
          for (let k = 0; k < 3; k++) {
            const rr = (e * 90 - k * 14) * r.big; if (rr <= 0) continue;
            ctx.globalAlpha = Math.min(1, a * (1 - k * 0.3)); ctx.beginPath(); ctx.arc(r.x, r.y, rr, 0, TAU); ctx.stroke();
          }
        }
      },
    };
  },
});

let off = null;
export default {
  ...base,
  start(canvas, opts = {}) {
    base.start(canvas, opts);
    off?.();
    if (opts.animate !== false && typeof globalThis.addEventListener === 'function' && typeof canvas.getBoundingClientRect === 'function') {
      const on = (e) => {
        const b = canvas.getBoundingClientRect();
        if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom && b.width > 0) drop?.((e.clientX - b.left) * (canvas.width / b.width), (e.clientY - b.top) * (canvas.height / b.height));
      };
      globalThis.addEventListener('pointerdown', on, { passive: true, capture: true });
      off = () => { globalThis.removeEventListener('pointerdown', on, { capture: true }); off = null; };
    }
  },
  stop() { off?.(); drop = null; base.stop(); },
};
