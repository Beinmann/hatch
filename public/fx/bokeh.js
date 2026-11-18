// Bokeh: soft out-of-focus discs in four warm and cool tints rise slowly and sway, blended additively. Each tint is drawn once into a
// small sprite; a frame is only drawImage calls.
import { makeEffect, countFor, rnd } from './loop.js';
const TAU = Math.PI * 2, TINTS = ['255,190,110', '255,140,150', '150,190,255', '170,240,200'];
let sprites = null;

function makeSprites() {
  if (sprites) return sprites;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  sprites = TINTS.map((c) => {
    const s = document.createElement('canvas'); s.width = s.height = 64; const g = s.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 10, 32, 32, 31); gr.addColorStop(0, `rgba(${c},.5)`); gr.addColorStop(0.85, `rgba(${c},.8)`); gr.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(32, 32, 31, 0, TAU); g.fill(); return s;
  });
  return sprites;
}

export default makeEffect('bokeh', {
  fps: 24, still: 40,
  create(w, h, level) {
    const spr = makeSprites();
    const B = spr ? Array.from({ length: countFor(w, h, 9000, level, 40) }, () => ({ x: rnd(0, w), y: rnd(0, h), r: rnd(8, 30), vy: -rnd(4, 14), sw: rnd(3, 10), ph: rnd(0, TAU), a: rnd(0.2, 0.55), c: spr[Math.floor(Math.random() * spr.length)] })) : [];
    let T = 0;
    return {
      step(dt) { T += dt; for (const b of B) { b.y += b.vy * dt; if (b.y < -b.r) { b.y = h + b.r; b.x = rnd(0, w); } } },
      draw(ctx) {
        if (!B.length) return;
        ctx.globalCompositeOperation = 'lighter';
        for (const b of B) { ctx.globalAlpha = Math.min(1, 0.12 * b.a * level.alpha * (0.8 + 0.2 * Math.sin(T * 0.6 + b.ph))); const x = b.x + b.sw * Math.sin(T * 0.3 + b.ph); ctx.drawImage(b.c, x - b.r, b.y - b.r, b.r * 2, b.r * 2); }
        ctx.globalCompositeOperation = 'source-over';
      },
    };
  },
});
