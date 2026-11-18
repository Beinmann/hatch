// Constellation: points in 3D space drift inside a box that slowly sways (yaw and pitch), drawn with perspective: near points are bigger
// and brighter, far ones smaller and dimmer. Pairs closer than LINK in 3D are joined by a line that fades with that distance (and with depth).
// At most MAX nodes, so the pair loop stays at ~2400 distance checks per frame.
import { makeEffect, countFor, rnd } from './loop.js';
const MAX = 70, LINK = 190, LINK2 = LINK * LINK, FOCAL = 520, DEPTH = 320;

export default makeEffect('constellation', {
  fps: 30, still: 30,
  create(w, h, level) {
    const n = countFor(w, h, 9000, level, MAX), hw = w * 0.6, hh = h * 0.6; // the box is a bit wider than the screen so sway never shows an edge
    const P = Array.from({ length: n }, () => ({ x: rnd(-hw, hw), y: rnd(-hh, hh), z: rnd(-DEPTH, DEPTH), vx: rnd(-8, 8), vy: rnd(-8, 8), vz: rnd(-8, 8), sx: 0, sy: 0, k: 0, rx: 0, ry: 0, rz: 0 }));
    let T = 0;
    return {
      step(dt) {
        T += dt;
        for (const p of P) {
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.x < -hw || p.x > hw) p.vx = -p.vx; if (p.y < -hh || p.y > hh) p.vy = -p.vy; if (p.z < -DEPTH || p.z > DEPTH) p.vz = -p.vz;
        }
        const yaw = 0.45 * Math.sin(T * 0.07), pit = 0.18 * Math.sin(T * 0.05 + 1), cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit);
        for (const p of P) { // rotate (kept in p.rx..), then project
          const x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy, y2 = p.y * cp - z1 * sp, z2 = p.y * sp + z1 * cp;
          p.k = FOCAL / (FOCAL + z2 + DEPTH); p.sx = w / 2 + x1 * p.k; p.sy = h / 2 + y2 * p.k; p.rx = x1; p.ry = y2; p.rz = z2;
        }
      },
      draw(ctx) {
        if (!n || level.count <= 0) return;
        ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgb(120,200,230)';
        for (let i = 0; i < n; i++) {
          const a = P[i]; if (a.sx < -20 || a.sx > w + 20 || a.sy < -20 || a.sy > h + 20) continue;
          for (let j = i + 1; j < n; j++) {
            const b = P[j], dx = a.rx - b.rx, dy = a.ry - b.ry, dz = a.rz - b.rz, d = dx * dx + dy * dy + dz * dz;
            if (d >= LINK2) continue;
            ctx.globalAlpha = Math.min(1, (1 - d / LINK2) * 0.3 * level.alpha * Math.min(1, (a.k + b.k) * 0.5 * 1.1));
            ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
          }
        }
        ctx.fillStyle = 'rgb(190,230,245)';
        for (const p of P) {
          const s = 1 + 1.6 * p.k; // about 1.5 px far away, 3.5 px near
          ctx.globalAlpha = Math.min(1, 0.55 * p.k * level.alpha * 1.1); ctx.fillRect(p.sx - s / 2, p.sy - s / 2, s, s);
        }
      },
    };
  },
});
