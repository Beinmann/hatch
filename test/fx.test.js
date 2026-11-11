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
  const canvas = () => ({ clientWidth: 640, clientHeight: 360, width: 0, height: 0, getContext: () => ctx2d() });
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
