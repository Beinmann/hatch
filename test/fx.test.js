import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFx, setFx, EFFECTS, FxError } from '../src/fx.js';
import { startHatch, tmp } from './helpers.js';

const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const ui = (args, state) => new Promise((resolve) => {
  const p = spawn('node', [UI, '--state', state, ...args], { env: { ...process.env, HATCH_STATE: '', HATCH_URL: '', HATCH_PLAN: '' } });
  let stdout = ''; let stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});

const fx0 = (o = {}) => ({ effect: null, intensity: 50, intensities: {}, ...o });
const names = () => EFFECTS.join(', ');

test('fx.json: missing is off, set and clear round trip, unknown names are refused, bad files warn and mean off', () => {
  const dir = tmp();
  assert.deepEqual(readFx(dir), fx0());
  assert.equal(setFx(dir, 'Matrix').effect, 'matrix'); assert.deepEqual(readFx(dir), fx0({ effect: 'matrix' }));
  assert.equal(setFx(dir, 'rain').effect, 'rain'); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'fx.json'), 'utf8')).effect, 'rain');
  assert.throws(() => setFx(dir, 'snow'), FxError); assert.equal(readFx(dir).effect, 'rain', 'a refused name changes nothing');
  assert.equal(setFx(dir, 'off').effect, null); assert.equal(fs.existsSync(path.join(dir, 'fx.json')), false);
  fs.writeFileSync(path.join(dir, 'fx.json'), '{oops'); assert.match(readFx(dir).problem, /not valid JSON/); assert.equal(readFx(dir).effect, null);
  fs.writeFileSync(path.join(dir, 'fx.json'), '{"effect":"snow"}'); assert.match(readFx(dir).problem, new RegExp(`unknown.*${names()}`));
  fs.writeFileSync(path.join(dir, 'fx.json'), '{"effect":"off"}'); assert.deepEqual(readFx(dir), fx0());
  assert.throws(() => setFx(dir), FxError, 'nothing to set');
});

test('fx.json intensity: per effect, plain files still work, hand edits and bad values fall back to 50 with a warning', () => {
  const dir = tmp(); const f = path.join(dir, 'fx.json'); const put = (v) => fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
  put({ effect: 'matrix' }); assert.equal(readFx(dir).intensity, 50); assert.equal(readFx(dir).problem, undefined);
  assert.deepEqual(setFx(dir, 'rain', 30), { effect: 'rain', intensity: 30 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { effect: 'rain', intensity: { rain: 30 } });
  assert.deepEqual(setFx(dir, 'matrix', 80), { effect: 'matrix', intensity: 80 });
  assert.equal(readFx(dir).intensities.rain, 30, 'switching effects keeps the other one');
  assert.deepEqual(setFx(dir, 'rain'), { effect: 'rain', intensity: 30 }, 'a name alone keeps the stored value');
  assert.deepEqual(setFx(dir, undefined, '70'), { effect: 'rain', intensity: 70 }, 'no name = the active effect; numeric strings are fine');
  setFx(dir, 'off'); assert.deepEqual(readFx(dir), fx0({ intensities: { rain: 70, matrix: 80 } }), 'off keeps the settings');
  assert.throws(() => setFx(dir, undefined, 10), /no effect is active/);
  for (const bad of [-1, 101, 'abc', NaN, {}, true]) { assert.throws(() => setFx(dir, 'rain', bad), FxError, String(bad)); }
  assert.equal(readFx(dir).intensities.rain, 70, 'a refused value changes nothing');
  put({ effect: 'rain', intensity: { rain: 'loud', matrix: 20, snow: 5 } });
  const r = readFx(dir); assert.equal(r.intensity, 50); assert.deepEqual(r.intensities, { matrix: 20 }); assert.match(r.problem, /intensity of rain.*0 to 100/); assert.match(r.problem, /snow/);
  put({ effect: 'rain', intensity: 33 }); assert.equal(readFx(dir).intensity, 33, 'a bare number means the active effect');
  put({ effect: 'rain', intensity: [1] }); assert.equal(readFx(dir).intensity, 50); assert.ok(readFx(dir).problem);
  put({ effect: 'rain', intensity: 500 }); assert.equal(readFx(dir).intensity, 50); assert.ok(readFx(dir).problem);
  put('[1,2]'); assert.equal(readFx(dir).effect, null);
  put({ effect: 'matrix', intensity: { matrix: 99.6 } }); assert.equal(readFx(dir).intensity, 100);
});

test('server: fx is in the snapshot, POST /api/fx saves it and emits an event, a hand edit is picked up, a bad file warns', async () => {
  const h = await startHatch();
  try {
    assert.deepEqual(h.hatch.state.snapshot().fx, { effect: null, intensity: 50 });
    const events = []; const old = h.hatch.bus.emit; h.hatch.bus.emit = (e, d) => { events.push([e, d]); return old.call(h.hatch.bus, e, d); };
    let r = await h.call('POST', '/api/fx', { effect: 'rain' }); assert.equal(r.status, 200); assert.equal(r.data.effect, 'rain'); assert.equal(r.data.intensity, 50); assert.deepEqual(r.data.effects, EFFECTS);
    assert.equal(h.hatch.state.snapshot().fx.effect, 'rain'); assert.ok(events.some(([e, d]) => e === 'fx' && d.effect === 'rain'), 'open pages are told');
    r = await h.call('POST', '/api/fx', { intensity: 30 }); assert.equal(r.status, 200); assert.equal(r.data.intensity, 30);
    assert.deepEqual(events.at(-1), ['fx', { effect: 'rain', intensity: 30 }], 'an intensity change alone is pushed too');
    assert.deepEqual(h.hatch.state.snapshot().fx, { effect: 'rain', intensity: 30 });
    r = await h.call('POST', '/api/fx', { effect: 'matrix', intensity: 90 }); assert.deepEqual([r.data.effect, r.data.intensity], ['matrix', 90]);
    r = await h.call('POST', '/api/fx', { effect: 'rain' }); assert.equal(r.data.intensity, 30, 'each effect keeps its own');
    assert.equal((await h.call('GET', '/api/fx')).data.intensity, 30);
    assert.equal((await h.call('POST', '/api/fx', { effect: 'snow' })).status, 400);
    assert.equal((await h.call('POST', '/api/fx', { intensity: 101 })).status, 400);
    assert.equal((await h.call('POST', '/api/fx', {})).status, 400);
    fs.writeFileSync(path.join(h.stateDir, 'fx.json'), '{"effect":"matrix"}'); h.hatch.state.rescan(); assert.equal(h.hatch.state.snapshot().fx.effect, 'matrix');
    fs.writeFileSync(path.join(h.stateDir, 'fx.json'), 'nope'); h.hatch.state.rescan();
    assert.equal(h.hatch.state.snapshot().fx.effect, null); assert.ok(h.hatch.state.snapshot().warnings.some((w) => w.file === 'fx'));
    r = await h.call('POST', '/api/fx', { effect: 'off' }); assert.equal(r.data.effect, null); assert.equal(h.hatch.state.snapshot().warnings.some((w) => w.file === 'fx'), false, 'the warning clears');
  } finally { await h.close(); }
});

test('CLI: hatch fx shows, switches, sets the intensity and rejects unknown effects and bad values', async () => {
  const h = await startHatch();
  try {
    let r = await ui(['fx'], h.stateDir); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /active: none/); assert.match(r.stdout, new RegExp(`${names()}, off`));
    r = await ui(['fx', 'matrix'], h.stateDir); assert.equal(r.status, 0, r.stderr); assert.equal(readFx(h.stateDir).effect, 'matrix');
    r = await ui(['fx', '--json'], h.stateDir); assert.equal(JSON.parse(r.stdout).effect, 'matrix'); assert.equal(JSON.parse(r.stdout).intensity, 50);
    r = await ui(['fx', 'rain', '--intensity', '30'], h.stateDir); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /intensity 30/); assert.deepEqual([readFx(h.stateDir).effect, readFx(h.stateDir).intensity], ['rain', 30]);
    r = await ui(['fx', 'matrix'], h.stateDir); r = await ui(['fx', 'rain'], h.stateDir); assert.equal(readFx(h.stateDir).intensity, 30, 'the stored intensity is kept');
    r = await ui(['fx', '--intensity=70'], h.stateDir); assert.equal(r.status, 0, r.stderr); assert.equal(readFx(h.stateDir).intensity, 70); assert.equal(readFx(h.stateDir).effect, 'rain');
    r = await ui(['fx'], h.stateDir); assert.match(r.stdout, /active: rain \(intensity 70/);
    r = await ui(['fx', '--intensity', '150'], h.stateDir); assert.equal(r.status, 1); assert.match(r.stderr, /0 to 100/); assert.equal(readFx(h.stateDir).intensity, 70);
    r = await ui(['fx', 'snow'], h.stateDir); assert.equal(r.status, 1); assert.match(r.stderr, /unknown effect/); assert.equal(readFx(h.stateDir).effect, 'rain');
    r = await ui(['fx', 'off'], h.stateDir); assert.equal(r.status, 0); assert.equal(readFx(h.stateDir).effect, null);
    r = await ui(['fx', '--intensity', '10'], h.stateDir); assert.equal(r.status, 1); assert.match(r.stderr, /no effect is active/);
  } finally { await h.close(); }
});

test('every effect has a module with start/stop/resize and a loader in public/fx.js', async () => {
  const loader = fs.readFileSync(new URL('../public/fx.js', import.meta.url), 'utf8');
  for (const name of EFFECTS) {
    assert.match(loader, new RegExp(`${name}: \\(\\) => import\\('\\./fx/${name}\\.js'\\)`));
    const mod = (await import(`../public/fx/${name}.js`)).default;
    assert.equal(mod.name, name); for (const fn of ['start', 'stop', 'resize']) assert.equal(typeof mod[fn], 'function', `${name}.${fn}`);
  }
});

test('effects run their simulation and drawing against a stub canvas without throwing (no browser: only the code paths are checked)', async () => {
  const calls = {};
  const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls[k] = (calls[k] || 0) + 1; return k.startsWith('create') ? { addColorStop() {} } : undefined; }), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = () => ({ clientWidth: 640, clientHeight: 360, width: 0, height: 0, getContext: (kind) => (kind === '2d' ? ctx2d() : null) }); // no WebGL here: rain takes its 2d fallback
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.document = { hidden: false, createElement: () => canvas() };
  let queued = null; globalThis.requestAnimationFrame = (f) => { queued = f; return 1; }; globalThis.cancelAnimationFrame = () => {};
  try {
    for (const name of EFFECTS) {
      const mod = (await import(`../public/fx/${name}.js`)).default; const c = canvas();
      mod.start(c, { animate: false }); assert.ok(c.width === 640 && c.height === 360, `${name} sizes its canvas`); mod.resize(); mod.stop();
      mod.start(c, { animate: true }); for (let t = 100; t < 1500; t += 40) queued(t); mod.resize(); mod.stop();
      assert.equal(typeof mod.setIntensity, 'function', `${name}.setIntensity`);
      for (const lvl of [undefined, 0, 50, 100, NaN, 'x']) { // every level, also before start and bad ones, draws without throwing
        mod.start(c, { animate: true, intensity: lvl }); for (let t = 100; t < 800; t += 40) queued(t);
        for (const n of [0, 100, 50, NaN, undefined]) { mod.setIntensity(n); for (let t = 900; t < 1100; t += 40) queued(t); }
        mod.stop();
      }
      mod.start(c, { animate: false, intensity: 10 }); mod.setIntensity(90); mod.stop();
    }
    assert.ok(calls.clearRect > 0, 'clears the canvas each frame, so it stays transparent where nothing is drawn');
  } finally { Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf }); if (!saved.document) delete globalThis.document; }
});

test('matrix draws no opaque base: it clears, and its fillRect is never used (trails fade as alpha)', async () => {
  const calls = {};
  const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls[k] = (calls[k] || 0) + 1; return undefined; }), set: (t, k, v) => { t[k] = v; return true; } });
  const c = { clientWidth: 300, clientHeight: 200, width: 0, height: 0, getContext: () => ctx2d() };
  const mod = (await import('../public/fx/matrix.js')); globalThis.document = { hidden: false }; globalThis.cancelAnimationFrame = () => {};
  try { mod.default.start(c, { animate: false }); mod.default.stop(); } finally { delete globalThis.document; delete globalThis.cancelAnimationFrame; }
  assert.ok(calls.clearRect > 0); assert.equal(calls.fillRect, undefined); assert.ok(calls.fillText > 0);
  const { trailAlpha } = mod;
  assert.ok(trailAlpha(1, 0.4) > trailAlpha(0.3, 0.4) && trailAlpha(0.3, 0.4) > trailAlpha(0.05, 0.4), 'dimmer cells are more transparent');
  assert.ok(trailAlpha(1, 100) <= 1 && trailAlpha(0, 0) >= 0);
});

const seeded = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

test('rain physics: sizes are mixed, shapes are not all circles, drops stay long and fade slowly, runs wobble and slow down', async () => {
  const P = await import('../public/fx/rain-physics.js'); const rand = seeded(1);
  assert.ok(Math.abs(P.mergeRadius(3, 4) - 5) < 1e-9, 'r^2 adds up'); assert.ok(P.mergeRadius(2, 1) > 2);
  assert.equal(P.touches({ x: 0, y: 0, r: 4 }, { x: 4, y: 0, r: 1 }), true); assert.equal(P.touches({ x: 0, y: 0, r: 4 }, { x: 8, y: 0, r: 1 }), false);
  const rs = Array.from({ length: 4000 }, () => P.sampleRadius(rand));
  assert.ok(rs.every((r) => r >= 0.7 && r <= 14), 'radius range'); assert.ok(rs.filter((r) => r < 2.2).length > 0.5 * rs.length, 'many tiny'); assert.ok(rs.filter((r) => r > 6).length > 0.02 * rs.length, 'some large');
  const shapes = Array.from({ length: 500 }, () => P.sampleShape(rand, 6));
  assert.ok(shapes.some((s) => s.tail > 0.2) && shapes.some((s) => s.tail === 0), 'teardrops and round ones'); assert.ok(shapes.some((s) => Math.abs(s.sx - 1) > 0.1), 'flattened');
  assert.ok(shapes.every((s) => s.wob.length === 3 && Number.isFinite(s.sx) && Number.isFinite(s.sy)));
  const l0 = P.dropLook(0, 100), l1 = P.dropLook(30, 100), l2 = P.dropLook(75, 100), l3 = P.dropLook(99, 100), l4 = P.dropLook(100, 100);
  assert.ok(l0.alpha === 0 && l0.scale < 1 && l1.alpha === 1 && l1.scale === 1, 'condenses in, then holds');
  assert.ok(l2.alpha < 1 && l2.alpha > l3.alpha && l3.alpha > 0, 'fades slowly, last 40% of its life'); assert.ok(l4.dead && l4.alpha === 0 && !l3.dead);
  assert.equal(P.wavyOffset(0, 0.3), 0); assert.ok(Math.abs(P.wavyOffset(80, 0.2) - P.wavyOffset(80, 0.9)) > 0.5, 'seed varies the track');
  let maxStep = 0, prev = 0, sideways = false; for (let d = 1; d <= 300; d++) { const o = P.wavyOffset(d, 0.7); maxStep = Math.max(maxStep, Math.abs(o - prev)); prev = o; if (Math.abs(o) > 2) sideways = true; }
  assert.ok(maxStep < 1.5 && sideways, 'smooth but not straight');
  assert.ok(P.runSpeed(8, 0.5) > P.runSpeed(4, 0.5) && P.runSpeed(6, 0.99) < P.runSpeed(6, 0.5) / 3 && P.runSpeed(6, 1) > 0, 'heavier is faster; it slows to a stop');
  const f0 = P.trailFade(0, 45), f1 = P.trailFade(20, 45), f2 = P.trailFade(45, 45);
  assert.equal(f0.alpha, 1); assert.ok(f1.alpha < 1 && f1.width < f0.width && f2.dead && f2.alpha === 0 && P.trailFade(1, 0).dead);
});

test('rain physics: counts are finite for any canvas size, colours and the background mapping parse', async () => {
  const P = await import('../public/fx/rain-physics.js');
  for (const [w, h] of [[0, 0], [1, 1], [NaN, 5], [-3, 10], [1920, 1080], [1e6, 1e6]]) { const n = P.dropTarget(w, h, 520, 3200); assert.ok(Number.isInteger(n) && n >= 0 && n <= 3200, `${w}x${h}`); }
  assert.deepEqual(P.rainLevel(50), { alpha: 1, count: 1 });
  const id = P.bgTransform('fill', 1000, 500, 1000, 500); assert.ok(Math.abs(id.sx - 0.001) < 1e-9 && id.ox === 0 && id.oy === 0, 'same aspect: image = viewport');
  const cover = P.bgTransform('fill', 1000, 1000, 800, 400); assert.ok(Math.abs(cover.sx - 1 / 800) < 1e-9 && Math.abs(cover.oy - (0 - (400 - 800) / 2) / 800) < 1e-9, 'cover scales to the wider side and centres');
  const off = P.bgTransform('stretch', 100, 100, 1000, 500, 200, 50); assert.ok(Math.abs(off.ox - 0.2) < 1e-9 && Math.abs(off.oy - 0.1) < 1e-9, 'canvas offset in the viewport');
  assert.ok(P.bgTransform('fit', 200, 100, 400, 400).sx > 0 && P.bgTransform('center', 100, 100, 400, 400).sx === 0.01 && P.bgTransform('tile', 100, 100, 400, 400).ox === 0);
  assert.deepEqual(P.bgTransform('fill', 0, 0, 100, 100), { sx: 1, sy: 1, ox: 0, oy: 0 }); assert.deepEqual(P.bgTransform('fill', 10, 10, NaN, 100), { sx: 1, sy: 1, ox: 0, oy: 0 });
  assert.deepEqual(P.parseCssColor('rgb(255, 0, 51)'), [1, 0, 0.2, 1]); assert.deepEqual(P.parseCssColor('rgba(0, 0, 0, 0.5)'), [0, 0, 0, 0.5]);
  assert.deepEqual(P.parseCssColor('color(srgb 0.1 0.2 0.3 / 0.7)'), [0.1, 0.2, 0.3, 0.7]); assert.deepEqual(P.parseCssColor('#fff'), [1, 1, 1, 1]);
  assert.deepEqual(P.parseCssColor('wat', [9, 9, 9, 9]), [9, 9, 9, 9]); assert.deepEqual(P.parseCssColor('', [1, 1, 1, 1]), [1, 1, 1, 1]);
});

test('rain glass: density holds for minutes, drops live long, heavy drops run rarely and one at a time, wiping small drops and leaving a trail', async () => {
  const { createGlass, P } = await import('../public/fx/rain-sim.js');
  const g = createGlass({ W: 1000, H: 600, rand: seeded(7) }); const n0 = g.drops.length;
  assert.ok(n0 > 500, 'a wet pane to begin with'); assert.ok(g.drops.every((d) => d.life >= P.LIFE[0] && d.r > 0));
  let runs = 0, was = false, maxLive = 0, minN = n0, maxN = n0, trailPts = 0;
  for (let i = 0; i < 20 * 600; i++) { // ten minutes at 30 fps... of 0.05 s steps
    g.step(0.05); const run = g.running(); if (run && !was) runs++; was = run;
    if (i % 20 === 0) { minN = Math.min(minN, g.drops.length); maxN = Math.max(maxN, g.drops.length); maxLive = Math.max(maxLive, g.drops.filter((d) => d.run).length); trailPts = Math.max(trailPts, g.trails.reduce((s, t) => s + t.pts.length, 0)); }
  }
  assert.ok(minN > 0.8 * n0 && maxN < 1.25 * n0, `density holds (${minN}..${maxN} of ${n0})`);
  assert.ok(runs >= 6 && runs <= 30, `heavy drops run rarely (${runs} runs in 10 minutes)`); assert.equal(maxLive, 1, 'never two at once');
  assert.ok(trailPts > 10, 'a run leaves a trail');
  for (const d of g.drops) { assert.ok(Number.isFinite(d.x + d.y + d.r) && d.r <= P.MAX_R + 1e-9, 'finite and bounded'); }
  g.setCount(0); assert.equal(g.drops.length, 0); g.step(1); assert.equal(g.drops.length, 0, 'intensity 0 = no drops'); g.resize(0, 0); g.step(1);
  g.setCount(2); g.resize(300, 200); assert.ok(g.drops.length > 100);
});

test('rain glass: a running drop wipes the small drops on its way and stops, becoming an ordinary drop again', async () => {
  const { createGlass } = await import('../public/fx/rain-sim.js');
  const g = createGlass({ W: 300, H: 500, rand: seeded(3), count: 0 }); // count 0: no random drops, only the ones placed here
  const mk = (x, y, r, extra = {}) => ({ x, y, r, sx: 1, sy: 1, tail: 0, wob: [], age: 0, life: 1000, run: null, ...extra });
  const heavy = mk(150, 40, 6); const path = [mk(150, 120, 1), mk(152, 170, 1.2), mk(149, 220, 0.9)]; const far = mk(20, 150, 1);
  g.drops = [heavy, ...path, far]; g.nextRun = 0;
  for (let i = 0; i < 20 * 60 && !(g.T > 5 && !g.running()); i++) g.step(0.05);
  assert.ok(!g.running() && heavy.run === null, 'it came to rest'); assert.ok(heavy.y > 100, 'it moved down'); assert.ok(g.drops.includes(far), 'drops off its track are left alone');
  assert.ok(path.filter((d) => g.drops.includes(d)).length < 3, 'it took in drops on its way'); assert.ok(heavy.life < Infinity && heavy.age < 20, 'it is an ordinary drop with a normal life again');
});

test('rain water map: a drop is a dome (flat in the middle, steep at the rim), tails and flattening change the outline, everything is bounded', async () => {
  const R = await import('../public/fx/rain-raster.js'); const { createGlass } = await import('../public/fx/rain-sim.js');
  const d = { x: 50, y: 50, r: 10, sx: 1, sy: 1, tail: 0, wob: [] };
  const mid = R.dropAt(d, 10, 50, 50), rim = R.dropAt(d, 10, 59, 50), out = R.dropAt(d, 10, 80, 50);
  assert.ok(Math.hypot(mid.nx, mid.ny) < 0.05 && mid.cov === 1); assert.ok(rim.nx > 0.8 && rim.nx <= 1 && rim.cov > 0); assert.equal(out, null);
  assert.ok(R.dropAt(d, 10, 50, 41).ny < -0.8 && R.dropAt(d, 10, 50, 59).ny > 0.8, 'normals point outward');
  const tailed = { ...d, tail: 0.8 }; assert.equal(R.dropAt(d, 10, 50, 28), null); assert.ok(R.dropAt(tailed, 10, 50, 36), 'a tail reaches further up'); assert.equal(R.dropAt(tailed, 10, 50, 62), null, 'but not down');
  assert.ok(R.dropAt(tailed, 10, 56, 38) === null || R.dropAt(tailed, 10, 56, 38).cov < 1, 'and it narrows to a point');
  const flat = { ...d, sx: 1.2, sy: 0.8 }; assert.ok(R.dropAt(flat, 10, 61, 50) && !R.dropAt(flat, 10, 50, 59.5) , 'flattened drop is wider than tall');
  const g = createGlass({ W: 120, H: 80, rand: seeded(5) }); const buf = new Uint8Array(120 * 80 * 4); R.rasterize(buf, 120, 80, g);
  let wet = 0, dry = 0; for (let i = 0; i < buf.length; i += 4) { if (buf[i + 3] > 0) wet++; else if (buf[i] + buf[i + 1] + buf[i + 2] === 0) dry++; }
  assert.ok(wet > 100 && dry > 100, 'some wet pixels, and dry glass stays fully clear');
  const base = new Uint8Array(buf.length), live = new Uint8Array(buf.length); R.rasterStatic(base, 120, 80, g); R.rasterLive(live, base, 120, 80, g); assert.deepEqual(live, buf);
  R.rasterize(new Uint8Array(4), 1, 1, createGlass({ W: 1, H: 1 })); // a 1px glass does not throw
});

test('rain effect: 2d fallback without WebGL draws shapes with alpha only; WebGL path uploads a water map and draws; a failing shader gives no effect, not a crash', async () => {
  const bad = []; const calls = {};
  const finite = (a) => a.every((v) => typeof v !== 'number' || Number.isFinite(v));
  const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls[k] = (calls[k] || 0) + 1; if (!finite(a)) bad.push([k, a]); return String(k).startsWith('create') ? { addColorStop() {} } : undefined; }), set: (t, k, v) => { t[k] = v; return true; } });
  const gcalls = {}; let compileOk = true;
  const fakeGl = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : (...a) => { gcalls[k] = (gcalls[k] || []); gcalls[k].push(a); if (!finite(a)) bad.push([k, a]); return k === 'getShaderParameter' || k === 'getProgramParameter' ? compileOk : k === 'getExtension' ? null : {}; }) });
  let kind = '2d';
  const mk = (w, h) => ({ clientWidth: w, clientHeight: h, width: 0, height: 0, parentElement: null, getBoundingClientRect: () => ({ left: 3, top: 4 }), getContext: (k) => (k === '2d' ? (kind === '2d' ? ctx2d() : null) : kind === 'gl' ? fakeGl() : null) });
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, gcs: globalThis.getComputedStyle };
  globalThis.document = { hidden: false, body: {}, documentElement: { classList: { contains: () => false }, dataset: {} }, createElement: () => mk(1, 1) };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', backgroundColor: 'rgb(10, 20, 30)' });
  let queued = null; globalThis.requestAnimationFrame = (f) => { queued = f; return 1; }; globalThis.cancelAnimationFrame = () => {};
  try {
    const rain = (await import('../public/fx/rain.js')).default;
    for (const [w, h] of [[0, 0], [1, 1], [800, 500]]) {
      const c = mk(w, h); rain.start(c, { animate: false }); assert.ok(c.width >= 1 && c.height >= 1); rain.resize(); rain.stop();
      rain.start(c, { animate: true }); for (let t = 100; t < 2000; t += 33) queued(t); rain.stop();
    }
    assert.ok(calls.clearRect > 0 && calls.fill > 0 && calls.ellipse > 0, 'fallback draws drops'); assert.deepEqual(bad, [], 'no NaN or Infinity reached the 2d canvas');
    kind = 'gl';
    for (const [w, h] of [[0, 0], [640, 360]]) {
      const c = mk(w, h); rain.start(c, { animate: true, intensity: 70 }); const t0 = performance.now(); for (let t = t0 + 100; t < t0 + 3000; t += 33) queued(t); rain.setIntensity(20); queued(t0 + 3100); rain.resize(); rain.stop();
      rain.start(c, { animate: false }); rain.stop();
    }
    assert.ok(gcalls.drawArrays?.length > 20 && gcalls.texSubImage2D?.length > 20, 'draws and uploads the water map');
    assert.ok(gcalls.texSubImage2D.some((a) => a[4] === 640 && a[5] === 360 && a[8].length === 640 * 360 * 4), 'the map is one RGBA pixel per canvas pixel');
    assert.deepEqual(bad, [], 'no NaN or Infinity reached WebGL');
    compileOk = false; const warn = console.warn; console.warn = () => {};
    try { const c = mk(100, 100); rain.start(c, { animate: true }); rain.stop(); } finally { console.warn = warn; }
  } finally { Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf, getComputedStyle: saved.gcs }); if (!saved.document) delete globalThis.document; if (!saved.gcs) delete globalThis.getComputedStyle; }
});

test('createFx gives every effect start a fresh canvas (a canvas keeps its first context type, 2d or webgl, for life)', async () => {
  const saved = { document: globalThis.document, RO: globalThis.ResizeObserver, mm: globalThis.matchMedia, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.document = { hidden: true, documentElement: { classList: { add() {}, remove() {} } } }; globalThis.ResizeObserver = class { observe() {} disconnect() {} }; globalThis.matchMedia = () => ({ matches: false });
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  try {
    const { createFx } = await import('../public/fx.js'); const made = [];
    const mkCanvas = () => { const c = { clientWidth: 100, clientHeight: 50, parentNode: {}, getContext: (k) => k !== '2d' ? null : new Proxy({}, { get: () => () => ({ addColorStop() {} }), set: () => true }), getBoundingClientRect: () => ({ left: 0, top: 0 }), cloneNode: () => { const n = mkCanvas(); made.push(n); return n; }, replaceWith(n) { c.replacedBy = n; } }; return c; };
    const first = mkCanvas(); const fx = createFx({ canvas: first, root: globalThis.document.documentElement });
    await fx.set('matrix', 50); await fx.set('rain', 50); await fx.set('off');
    assert.equal(made.length, 2, 'one fresh canvas per start'); assert.equal(first.replacedBy, made[0]); assert.equal(made[0].replacedBy, made[1]);
  } finally { Object.assign(globalThis, { document: saved.document, ResizeObserver: saved.RO, matchMedia: saved.mm, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf }); if (!saved.raf) { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; }; if (!saved.document) delete globalThis.document; }
});

test('intensity maps to each effect: 50 is the default look, 0 is off, 100 is stronger, anything odd counts as 50', async () => {
  const { factor } = await import('../public/fx/intensity.js');
  assert.equal(factor(50), 1); assert.equal(factor(0), 0); assert.equal(factor(100), 2); assert.equal(factor(500), 2); assert.equal(factor(-5), 0);
  for (const bad of [NaN, undefined, null, 'x', Infinity]) assert.equal(factor(bad), 1, String(bad));
  const { matrixLevel } = await import('../public/fx/matrix.js'); const { rainLevel } = await import('../public/fx/rain-physics.js');
  assert.deepEqual(matrixLevel(50), { dens: 1, bright: 1 }); assert.deepEqual(rainLevel(50), { alpha: 1, count: 1 });
  assert.ok(matrixLevel(80).dens > 1 && matrixLevel(20).bright < 1 && rainLevel(80).count > 1 && rainLevel(20).alpha < 1);
});

test('createFx: switching effects, a live intensity change without a reload, and the terminal view reaches the effect', async () => {
  const saved = { document: globalThis.document, RO: globalThis.ResizeObserver, mm: globalThis.matchMedia };
  const seen = []; let setCalls = 0;
  globalThis.document = { documentElement: { classList: { add() {}, remove() {} } } };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const { createFx } = await import('../public/fx.js');
    const xterm = { cols: 80, rows: 24, onRender: () => ({ dispose() {} }), buffer: { active: { viewportY: 0, getLine: () => null, getNullCell: () => ({}) } } };
    const fx = createFx({ canvas: { clientWidth: 100, clientHeight: 50, getContext: () => new Proxy({}, { get: () => () => ({ addColorStop() {} }), set: () => true }), getBoundingClientRect: () => ({ left: 0, top: 0 }) }, root: globalThis.document.documentElement, getXterm: () => xterm });
    const real = await import('../public/fx/matrix.js'); const orig = { start: real.default.start, setIntensity: real.default.setIntensity };
    real.default.start = (c, o) => { seen.push(o); return orig.start(c, o); }; real.default.setIntensity = (n) => { setCalls++; return orig.setIntensity(n); };
    globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; globalThis.document.hidden = false;
    await fx.set('matrix', 30); assert.equal(fx.active(), 'matrix'); assert.equal(seen.length, 1); assert.equal(seen[0].intensity, 30); assert.equal(typeof seen[0].terminal.cellsWithText, 'function');
    await fx.set('matrix', 70); assert.equal(seen.length, 1, 'same effect: no restart'); assert.equal(setCalls, 1);
    await fx.set('matrix', 70); await fx.set(null); assert.equal(fx.active(), null);
    await fx.set('matrix'); assert.equal(seen.length, 2); assert.equal(seen[1].intensity, 70, 'a call without a level keeps the last one');
    const p1 = fx.set('matrix', 40), p2 = fx.set('matrix', 60); await Promise.all([p1, p2]); assert.equal(seen.length, 2, 'a repeat request while loading does not start twice');
    await fx.set('nope'); assert.equal(fx.active(), null);
    real.default.start = orig.start; real.default.setIntensity = orig.setIntensity; await fx.set(null);
  } finally { Object.assign(globalThis, { document: saved.document, ResizeObserver: saved.RO, matchMedia: saved.mm }); for (const k of ['document', 'ResizeObserver', 'matchMedia']) if (!saved[k === 'ResizeObserver' ? 'RO' : k === 'matchMedia' ? 'mm' : k]) delete globalThis[k]; delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; }
});
