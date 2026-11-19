// Constellation: points in 3D space drift inside a box that slowly sways (yaw and pitch), drawn with perspective: near points are big,
// bright and glowing, far ones small and dim. Pairs closer than LINK in 3D are joined by a line that fades with that distance and with depth.
// Cost: the nodes are kept sorted by rotated x (insertion sort, the order barely changes between frames) so the pair loop stops as soon as
// the x gap exceeds LINK instead of testing every pair; lines are batched into a few paths by strength (one stroke each); the node glow is a
// pre-rendered sprite, not a gradient per node.
// Intensity: 50 is already rich (node count and brightness), 100 is denser and brighter still.
import { makeEffect, countFor, rnd } from './loop.js';
const MAX = 320, LINK = 175, LINK2 = LINK * LINK, FOCAL = 480, DEPTH = 420, BUCKETS = 4;

// A soft round glow, drawn once; null when no canvas can be made (the nodes then still get their crisp core).
function glowSprite() {
  try {
    const c = globalThis.document?.createElement?.('canvas'); if (!c) return null;
    c.width = c.height = 48; const g = c.getContext('2d'), r = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    r.addColorStop(0, 'rgba(210,240,255,0.85)'); r.addColorStop(0.25, 'rgba(160,220,250,0.35)'); r.addColorStop(1, 'rgba(120,200,240,0)');
    g.fillStyle = r; g.fillRect(0, 0, 48, 48); return c;
  } catch { return null; }
}

export default makeEffect('constellation', {
  fps: 30, still: 30,
  create(w, h, level) {
    const n = level.count > 0 ? Math.min(MAX, Math.max(Math.round(45 * level.count), countFor(w, h, 12000, level, MAX))) : 0;
    const hw = w * 0.6, hh = h * 0.6; // the box is a bit wider than the screen so sway never shows an edge
    const P = Array.from({ length: n }, () => ({ x: rnd(-hw, hw), y: rnd(-hh, hh), z: rnd(-DEPTH, DEPTH), vx: rnd(-9, 9), vy: rnd(-9, 9), vz: rnd(-9, 9), sx: 0, sy: 0, k: 0, rx: 0, ry: 0, rz: 0, n: 0 }));
    const order = P.slice(), glow = glowSprite(); let T = 0;
    return {
      step(dt) {
        T += dt;
        for (const p of P) {
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.x < -hw || p.x > hw) p.vx = -p.vx; if (p.y < -hh || p.y > hh) p.vy = -p.vy; if (p.z < -DEPTH || p.z > DEPTH) p.vz = -p.vz;
        }
        const yaw = 0.45 * Math.sin(T * 0.07), pit = 0.18 * Math.sin(T * 0.05 + 1), cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit);
        for (const p of P) { // rotate (kept in p.rx..), then project; p.n is nearness 0 (far) .. 1 (near)
          const x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy, y2 = p.y * cp - z1 * sp, z2 = p.y * sp + z1 * cp;
          p.k = FOCAL / (FOCAL + z2 + DEPTH); p.sx = w / 2 + x1 * p.k; p.sy = h / 2 + y2 * p.k; p.rx = x1; p.ry = y2; p.rz = z2;
          p.n = Math.max(0, Math.min(1, 1 - (z2 + DEPTH) / (2 * DEPTH)));
        }
        for (let i = 1; i < order.length; i++) { const o = order[i]; let j = i - 1; while (j >= 0 && order[j].rx > o.rx) { order[j + 1] = order[j]; j--; } order[j + 1] = o; }
      },
      draw(ctx) {
        if (!n || level.count <= 0) return;
        const A = level.alpha, segs = Array.from({ length: BUCKETS }, () => []); // flat x1,y1,x2,y2 per bucket (no Path2D: it is missing where the tests run)
        for (let i = 0; i < n; i++) {
          const a = order[i]; if (a.sx < -30 || a.sx > w + 30 || a.sy < -30 || a.sy > h + 30) continue;
          for (let j = i + 1; j < n; j++) {
            const b = order[j], dx = b.rx - a.rx; if (dx >= LINK) break;
            const dy = a.ry - b.ry, dz = a.rz - b.rz, d = dx * dx + dy * dy + dz * dz; if (d >= LINK2) continue;
            const s = (1 - d / LINK2) * (0.35 + 0.65 * (a.n + b.n) * 0.5); // 0..1: closer and nearer is stronger
            segs[Math.min(BUCKETS - 1, Math.floor(s * BUCKETS))].push(a.sx, a.sy, b.sx, b.sy);
          }
        }
        ctx.strokeStyle = 'rgb(165,222,245)';
        for (let q = 0; q < BUCKETS; q++) { ctx.lineWidth = 0.9 + 0.4 * q; ctx.globalAlpha = Math.min(1, (0.28 + 0.2 * q) * A); const v = segs[q]; ctx.beginPath(); for (let m = 0; m < v.length; m += 4) { ctx.moveTo(v[m], v[m + 1]); ctx.lineTo(v[m + 2], v[m + 3]); } ctx.stroke(); }
        ctx.fillStyle = 'rgb(225,245,255)';
        for (const p of P) {
          if (p.sx < -30 || p.sx > w + 30 || p.sy < -30 || p.sy > h + 30) continue;
          const r = 1 + 3 * p.n * p.n + 0.6 * p.n, br = Math.min(1, (0.35 + 0.65 * p.n) * A); // radius 1..4.6 px, brightness 0.35..1 (times intensity)
          if (glow) { ctx.globalAlpha = Math.min(1, br * 0.8); ctx.drawImage(glow, p.sx - r * 3.2, p.sy - r * 3.2, r * 6.4, r * 6.4); }
          ctx.globalAlpha = br; ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, 6.2832); ctx.fill();
        }
      },
    };
  },
});
