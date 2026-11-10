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
    assert.ok(calls.fillRect > 0, 'drew a base');
  } finally { Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf }); if (!saved.document) delete globalThis.document; }
});
