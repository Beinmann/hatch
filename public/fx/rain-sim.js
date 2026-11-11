// The pane of glass as a pure simulation (no canvas, no globals; `rand` is injected so tests are repeatable). Resting drops of mixed sizes
// shrink steadily over their life (they evaporate) and fade only at the very end, while new ones condense at a constant, steady rate
// (never in bursts) that keeps the density at its target. Rarely one drop swells, runs a short wavy way down, wipes the small drops it
// meets and leaves a thin wet trail. Nothing drips on a timer: runs are rare events.
import { clamp, mergeRadius, touches, sampleRadius, sampleShape, dropLook, wavyOffset, runSpeed, trailFade, dropTarget } from './rain-physics.js';

export const P = {
  DENSITY: 520,          // px^2 of glass per resting drop (before the intensity setting scales the count)
  MAX_DROPS: 3200,       // hard cap on resting drops
  LIFE: [45, 120],       // seconds a resting drop lives: it shrinks the whole time and fades only in the last 20%
  SPAWN_JITTER: 0.6,     // 0..1: how much the gap between new drops varies (0 = metronome); the average rate stays n / mean life
  OVERSHOOT: 1.15,       // new drops pause only if the pane holds this many times its target (runs and the intensity setting can push it up)
  RUN_EVERY: [22, 65],   // seconds between runs of a heavy drop (rare on purpose)
  RUN_LEN: [90, 260],    // px a heavy drop runs before it stops again
  RUN_R: [6.5, 11],      // radius a drop swells to before it lets go
  SWELL: [1.6, 3.2],     // seconds it takes to swell (it also takes in water from the drops around it)
  SHED: 0.004,           // radius lost per px run (water left behind as the trail)
  TRAIL_LIFE: 45,        // seconds until a wet trail has dried
  MAX_R: 16,             // no drop gets bigger than this
};

export function createGlass({ W = 1, H = 1, rand = Math.random, count = 1 } = {}) {
  const g = { W, H, T: 0, drops: [], trails: [], runner: null, count, nextRun: 0, spawnAcc: 0 };
  const between = ([a, b]) => a + rand() * (b - a);
  const target = () => (g.count <= 0 ? 0 : dropTarget(g.W, g.H, P.DENSITY / g.count, P.MAX_DROPS * Math.max(1, g.count)));

  function newDrop(over = {}) {
    const r = sampleRadius(rand);
    return { x: rand() * g.W, y: rand() * g.H, r, ...sampleShape(rand, r), age: 0, life: between(P.LIFE), run: null, ...over };
  }
  function place(d) { // a few tries to avoid condensing on top of a bigger drop
    for (let k = 0; k < 3; k++) {
      if (!g.drops.some((o) => o.r >= d.r && touches(o, d, 0.9))) return;
      d.x = rand() * g.W; d.y = rand() * g.H;
    }
  }
  function reseed() {
    g.drops = []; g.trails = []; g.runner = null; g.T = 0; g.nextRun = between(P.RUN_EVERY) * 0.5;
    for (let i = 0, n = target(); i < n; i++) { const d = newDrop(); d.age = rand() * d.life; g.drops.push(d); } // ages spread over the whole life = the steady state, so no wave of fading later
  }

  function startRun() {
    for (let k = 0; k < 40; k++) { // a medium or large resting drop with room below
      const d = g.drops[Math.floor(rand() * g.drops.length)];
      if (!d || d.run || d.r < 3 || d.r > 10 || d.y > g.H - 80 || d.age > d.life * 0.6) continue;
      const len = Math.min(between(P.RUN_LEN), g.H - d.y - 10);
      d.run = { phase: 'swell', t: 0, swell: between(P.SWELL), to: Math.max(d.r * 1.2, between(P.RUN_R)), len, dist: 0, x0: d.x, y0: d.y, seed: rand(), trail: null, since: 0 };
      d.life = Infinity; g.runner = d; return;
    }
  }
  function finishRun(d) { // it stops and sits there again as an ordinary drop
    d.run = null; g.runner = null; Object.assign(d, sampleShape(rand, d.r), { tail: 0.12, age: 0, life: between(P.LIFE) * 0.8 });
  }
  function wipe(d) { // the running drop takes in the small drops it passes
    for (let k = g.drops.length - 1; k >= 0; k--) {
      const o = g.drops[k];
      if (o !== d && o.r < d.r && touches(d, o, 0.9)) { d.r = Math.min(P.MAX_R, mergeRadius(d.r, o.r * 0.5)); g.drops[k] = g.drops[g.drops.length - 1]; g.drops.pop(); }
    }
  }

  function stepRunner(d, dt) {
    const run = d.run;
    if (run.phase === 'swell') { // gathers water, trembles, then lets go
      run.t += dt; const f = clamp(run.t / run.swell, 0, 1);
      d.r += (run.to - d.r) * clamp(dt * 1.2, 0, 1); d.tail = 0.25 * f; wipe(d);
      if (run.t >= run.swell) { run.phase = 'go'; run.trail = { pts: [] }; g.trails.push(run.trail); }
      return;
    }
    const dy = runSpeed(d.r, run.dist / Math.max(1, run.len)) * dt;
    run.dist += dy; run.since += dy;
    d.y = run.y0 + run.dist; d.x = run.x0 + wavyOffset(run.dist, run.seed);
    d.r = Math.max(2.4, d.r - P.SHED * dy); d.tail = Math.min(1.1, 0.35 + dy / dt / 80);
    wipe(d);
    const t = run.trail;
    if (run.since >= 3) { run.since = 0; t.pts.push({ x: d.x, y: d.y - d.r * 0.4, w: Math.max(1.3, d.r * 0.45), t: g.T }); if (rand() < 0.1) g.drops.push(newDrop({ x: d.x + (rand() - 0.5) * d.r * 1.6, y: d.y - d.r * 1.2, r: 0.6 + rand() * 0.8, age: 1 })); }
    if (run.dist >= run.len || d.y > g.H) { if (d.y > g.H) { g.drops.splice(g.drops.indexOf(d), 1); g.runner = null; } else finishRun(d); }
  }

  g.resize = (w, h) => { g.W = Math.max(1, w); g.H = Math.max(1, h); reseed(); };
  g.setCount = (c) => { g.count = c; reseed(); };
  g.running = () => !!g.runner;

  g.step = function step(dt) {
    dt = clamp(dt, 0, 0.5); g.T += dt;
    const n = target(); let resting = g.drops.length;
    // a constant trickle: as many new drops per second as die per second on average (n / mean life), with a jittered gap, whatever the count is now
    const meanLife = (P.LIFE[0] + P.LIFE[1]) / 2;
    g.spawnAcc += dt * (n / meanLife) * (1 + P.SPAWN_JITTER * (rand() * 2 - 1));
    while (g.spawnAcc >= 1) { g.spawnAcc -= 1; if (resting < n * P.OVERSHOOT) { const d = newDrop(); place(d); g.drops.push(d); resting++; } }
    if (g.runner) stepRunner(g.runner, dt);
    else if (g.T >= g.nextRun && g.drops.length) { g.nextRun = g.T + between(P.RUN_EVERY); startRun(); }
    let out = 0;
    for (const d of g.drops) { if (!d.run) { d.age += dt; } if (!d.run && d.age >= d.life) out++; }
    if (out) g.drops = g.drops.filter((d) => d.run || d.age < d.life);
    for (const t of g.trails) { let k = 0; while (k < t.pts.length && trailFade(g.T - t.pts[k].t, P.TRAIL_LIFE).dead) k++; if (k) t.pts.splice(0, k); }
    g.trails = g.trails.filter((t) => t.pts.length || g.runner?.run?.trail === t);
  };
  g.look = (d) => (d.run ? { alpha: 1, scale: 1 } : dropLook(d.age, d.life));
  g.trailFade = (p) => trailFade(g.T - p.t, P.TRAIL_LIFE);
  reseed();
  return g;
}
