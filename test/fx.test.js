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
  const p = spawn('node', [UI, '--state', state, ...args], { env: { ...process.env, HATCH_STATE: '' } });
  let stdout = ''; let stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('fx.json: missing is off, set and clear round trip, unknown names are refused, bad files warn and mean off', () => {
  const dir = tmp();
  assert.deepEqual(readFx(dir), { effect: null });
  assert.equal(setFx(dir, 'Matrix'), 'matrix'); assert.deepEqual(readFx(dir), { effect: 'matrix' });
  assert.equal(setFx(dir, 'rain'), 'rain'); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'fx.json'), 'utf8')).effect, 'rain');
  assert.throws(() => setFx(dir, 'snow'), FxError); assert.equal(readFx(dir).effect, 'rain', 'a refused name changes nothing');
  assert.equal(setFx(dir, 'off'), null); assert.equal(fs.existsSync(path.join(dir, 'fx.json')), false);
  fs.writeFileSync(path.join(dir, 'fx.json'), '{oops'); assert.match(readFx(dir).problem, /not valid JSON/); assert.equal(readFx(dir).effect, null);
  fs.writeFileSync(path.join(dir, 'fx.json'), '{"effect":"snow"}'); assert.match(readFx(dir).problem, /unknown.*matrix, rain/);
  fs.writeFileSync(path.join(dir, 'fx.json'), '{"effect":"off"}'); assert.deepEqual(readFx(dir), { effect: null });
});

test('server: fx is in the snapshot, POST /api/fx saves it and emits an event, a hand edit is picked up, a bad file warns', async () => {
  const h = await startHatch();
  try {
    assert.equal(h.hatch.state.snapshot().fx, null);
    const events = []; const old = h.hatch.bus.emit; h.hatch.bus.emit = (e, d) => { events.push([e, d]); return old.call(h.hatch.bus, e, d); };
    let r = await h.call('POST', '/api/fx', { effect: 'rain' }); assert.equal(r.status, 200); assert.equal(r.data.effect, 'rain'); assert.deepEqual(r.data.effects, EFFECTS);
    assert.equal(h.hatch.state.snapshot().fx, 'rain'); assert.ok(events.some(([e, d]) => e === 'fx' && d.effect === 'rain'), 'open pages are told');
    assert.equal((await h.call('GET', '/api/fx')).data.effect, 'rain');
    assert.equal((await h.call('POST', '/api/fx', { effect: 'snow' })).status, 400);
    fs.writeFileSync(path.join(h.stateDir, 'fx.json'), '{"effect":"matrix"}'); h.hatch.state.rescan(); assert.equal(h.hatch.state.snapshot().fx, 'matrix');
    fs.writeFileSync(path.join(h.stateDir, 'fx.json'), 'nope'); h.hatch.state.rescan();
    assert.equal(h.hatch.state.snapshot().fx, null); assert.ok(h.hatch.state.snapshot().warnings.some((w) => w.file === 'fx'));
    r = await h.call('POST', '/api/fx', { effect: 'off' }); assert.equal(r.data.effect, null); assert.equal(h.hatch.state.snapshot().warnings.some((w) => w.file === 'fx'), false, 'the warning clears');
  } finally { await h.close(); }
});

test('CLI: hatch fx shows, switches and rejects unknown effects', async () => {
  const h = await startHatch();
  try {
    let r = await ui(['fx'], h.stateDir); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /active: none/); assert.match(r.stdout, /matrix, rain, off/);
    r = await ui(['fx', 'matrix'], h.stateDir); assert.equal(r.status, 0, r.stderr); assert.equal(readFx(h.stateDir).effect, 'matrix');
    r = await ui(['fx', '--json'], h.stateDir); assert.equal(JSON.parse(r.stdout).effect, 'matrix');
    r = await ui(['fx', 'snow'], h.stateDir); assert.equal(r.status, 1); assert.match(r.stderr, /unknown effect/); assert.equal(readFx(h.stateDir).effect, 'matrix');
    r = await ui(['fx', 'off'], h.stateDir); assert.equal(r.status, 0); assert.equal(readFx(h.stateDir).effect, null);
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
  const canvas = () => ({ clientWidth: 640, clientHeight: 360, width: 0, height: 0, getContext: () => ctx2d() });
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.document = { hidden: false, createElement: () => canvas() };
  let queued = null; globalThis.requestAnimationFrame = (f) => { queued = f; return 1; }; globalThis.cancelAnimationFrame = () => {};
  try {
    for (const name of EFFECTS) {
      const mod = (await import(`../public/fx/${name}.js`)).default; const c = canvas();
      mod.start(c, { animate: false }); assert.ok(c.width === 640 && c.height === 360, `${name} sizes its canvas`); mod.resize(); mod.stop();
      mod.start(c, { animate: true }); for (let t = 100; t < 1500; t += 40) queued(t); mod.resize(); mod.stop();
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

test('rain physics: merging conserves area, drops grow, trails fade and narrow, speed eases, bursts alternate, absorption by contact', async () => {
  const P = await import('../public/fx/rain-physics.js');
  assert.ok(Math.abs(P.mergeRadius(3, 4) - 5) < 1e-9, 'r^2 adds up'); assert.ok(P.mergeRadius(2, 1) > 2);
  assert.equal(P.growRadius(2, 10, 0.1), 3); assert.equal(P.growRadius(2, 10, -1), 2, 'never shrinks by growth'); assert.equal(P.growRadius(NaN, 1, 1), 1);
  assert.ok(P.shedRadius(4, 100, 0.0035) < 4 && P.shedRadius(1, 1e6, 1) === 0);
  const f0 = P.trailFade(0, 7), f1 = P.trailFade(3.5, 7), f2 = P.trailFade(7, 7);
  assert.equal(f0.alpha, 1); assert.equal(f0.width, 1); assert.ok(f1.alpha < f0.alpha && f1.alpha > f2.alpha && f1.width < f0.width);
  assert.equal(f2.dead, true); assert.equal(f2.alpha, 0); assert.equal(P.trailFade(-5, 7).alpha, 1); assert.equal(P.trailFade(1, 0).dead, true);
  assert.ok(P.slideTarget(5) > P.slideTarget(2) && P.slideTarget(3, true) > P.slideTarget(3));
  let v = 0; for (let i = 0; i < 60; i++) v = P.approachSpeed(v, 30, 1 / 30); assert.ok(v > 29 && v <= 30); assert.equal(P.approachSpeed(5, 0, 0), 5);
  const spec = { go: [0.2, 0.2], stop: [0.5, 0.5] }; let b = { moving: true, t: 0.1 };
  b = P.stepBurst(b, 0.05, Math.random, spec); assert.equal(b.moving, true);
  b = P.stepBurst(b, 0.1, Math.random, spec); assert.deepEqual(b, { moving: false, t: 0.5 });
  b = P.stepBurst(b, 0.6, Math.random, spec); assert.deepEqual(b, { moving: true, t: 0.2 });
  assert.equal(P.touches({ x: 0, y: 0, r: 4 }, { x: 4, y: 0, r: 1 }), true); assert.equal(P.touches({ x: 0, y: 0, r: 4 }, { x: 6, y: 0, r: 1 }), false);
});

test('rain physics: counts and streaks are finite for any canvas size, including zero', async () => {
  const P = await import('../public/fx/rain-physics.js');
  for (const [w, h] of [[0, 0], [1, 1], [NaN, 5], [-3, 10], [1920, 1080], [1e6, 1e6]]) {
    const nb = P.beadCount(w, h, 1400, 700), nd = P.dropCount(w, h, 55000, 3, 40);
    assert.ok(Number.isInteger(nb) && nb >= 0 && nb <= 700, `beads ${w}x${h}`); assert.ok(Number.isInteger(nd) && nd >= 3 && nd <= 40, `drops ${w}x${h}`);
    for (const s of P.streakSpecs(w, [3, 6], Math.random)) { assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && s.r > 0 && s.fast); }
  }
  assert.ok(P.streakSpecs(500, [3, 6], Math.random).length >= 3);
});

test('rain runs against a stub canvas: zero-size canvas gives no NaN coordinates, a still frame clears and draws beads and trails with alpha only', async () => {
  const bad = []; const calls = {};
  const finite = (a) => a.every((v) => typeof v !== 'number' || Number.isFinite(v));
  const ctx2d = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls[k] = (calls[k] || 0) + 1; if (!finite(a)) bad.push([k, a]); return String(k).startsWith('create') ? { addColorStop() {} } : undefined; }), set: (t, k, v) => { t[k] = v; return true; } });
  const mk = (w, h) => ({ clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx2d() });
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.document = { hidden: false, createElement: () => mk(1, 1) };
  let queued = null; globalThis.requestAnimationFrame = (f) => { queued = f; return 1; }; globalThis.cancelAnimationFrame = () => {};
  try {
    const rain = (await import('../public/fx/rain.js')).default;
    for (const [w, h] of [[0, 0], [1, 1], [800, 500]]) {
      const c = mk(w, h); rain.start(c, { animate: false }); assert.ok(c.width >= 1 && c.height >= 1); rain.resize(); rain.stop();
      rain.start(c, { animate: true }); for (let t = 100; t < 2000; t += 33) queued(t); rain.stop();
    }
    assert.deepEqual(bad, [], 'no NaN or Infinity reached the canvas');
    assert.ok(calls.clearRect > 0 && calls.drawImage > 0 && calls.fill > 0); assert.ok(calls.fillRect <= calls.clearRect, 'the only fillRect is the faint mist gradient, once per frame');
  } finally { Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf }); if (!saved.document) delete globalThis.document; }
});
