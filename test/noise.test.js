import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, tmp } from './helpers.js';

const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const NOISE = fileURLToPath(new URL('../examples/widgets/noise/index.html', import.meta.url));
const FAKE_HOME = tmp();
const ui = (args, state) => new Promise((resolve) => {
  const p = spawn('node', [UI, '--state', state, ...args], { env: { ...process.env, HOME: FAKE_HOME, HATCH_STATE: '', HATCH_WORKSPACE: '' } });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const wins = async (h) => (await h.call('GET', '/api/panels')).data.filter((p) => p.type === 'widget' && p.props.name === 'noise');
const cmdFile = (h) => JSON.parse(fs.readFileSync(path.join(h.stateDir, 'widgets/noise/data/cmd'), 'utf8'));

test('noise: stop with no window opens nothing; a bad type is refused', async () => {
  const h = await startHatch();
  try {
    let r = await ui(['noise', 'stop'], h.stateDir); assert.equal(r.status, 0, r.stderr); assert.deepEqual(await wins(h), []);
    r = await ui(['noise', 'loud'], h.stateDir); assert.equal(r.status, 1); assert.match(r.stderr, /usage: noise/);
  } finally { await h.close(); }
});

test('noise: no window opens a minimized one and writes the command; default is brown', async () => {
  const h = await startHatch();
  try {
    let r = await ui(['noise'], h.stateDir); assert.equal(r.status, 0, r.stderr);
    const w = await wins(h); assert.equal(w.length, 1); assert.equal(w[0].minimized, true);
    assert.equal(cmdFile(h).c, 'brown');
    r = await ui(['noise', 'stop'], h.stateDir); assert.equal(r.status, 0, r.stderr);
    assert.equal(cmdFile(h).c, 'stop'); assert.equal((await wins(h)).length, 1, 'stop reuses the window');
  } finally { await h.close(); }
});

test('noise: an open window keeps its minimized state, visible or not', async () => {
  const h = await startHatch();
  try {
    await ui(['widget', 'open', 'noise'], h.stateDir);
    const id = (await wins(h))[0].id;
    await ui(['noise', 'pink'], h.stateDir); assert.ok(!(await wins(h))[0].minimized, 'stays visible'); assert.equal(cmdFile(h).c, 'pink');
    await h.call('PATCH', `/api/panels/${id}`, { minimized: true });
    await ui(['noise', 'white'], h.stateDir); const w = await wins(h);
    assert.equal(w.length, 1); assert.equal(w[0].minimized, true, 'stays minimized'); assert.equal(cmdFile(h).c, 'white');
  } finally { await h.close(); }
});

test('noise widget: runs a fresh command once, ignores old ones, reports blocked audio', async () => {
  const script = [...fs.readFileSync(NOISE, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  const el = () => ({ textContent: '', value: '40', children: [], dataset: {}, classList: { toggle() {} }, appendChild() {}, options: [] });
  const els = new Map(); const dom = { getElementById: (id) => { if (!els.has(id)) els.set(id, el()); return els.get(id); }, createElement: el };
  let handler; const played = []; let state = 'suspended'; let calls = 0;
  const hatch = { ready: (f) => f(), on: (s, f) => { handler = f; }, call: async () => { calls++; return { json: [] }; } };
  class AudioContext { get state() { return state; } resume() {} createGain() { return { gain: {}, connect() {}, disconnect() {} }; } createBuffer() { return { getChannelData: () => new Float32Array(1) }; }
    createBufferSource() { const s = { start() { played.push(1); }, stop() {}, connect() {}, disconnect() {} }; return s; } get destination() { return {}; } get sampleRate() { return 1; } }
  const ctx = vm.createContext({ hatch, document: dom, AudioContext, location: { hash: '' }, addEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout: (f) => f(), Date, Math, Float32Array, Promise });
  vm.runInContext(script, ctx);
  handler({ json: { c: 'pink', t: Date.now() - 60000 } }); assert.equal(played.length, 0, 'an old command is ignored');
  handler({ json: { c: 'pink', t: Date.now() } });
  assert.equal(vm.runInContext('type', ctx), 'pink'); assert.equal(played.length, 1);
  assert.match(els.get('sub').textContent, /blocked audio/); assert.equal(vm.runInContext('playing()', ctx), false, 'a blocked start does not look like playing');
  state = 'running'; handler({ json: { c: 'white', t: Date.now() + 5 } }); assert.equal(vm.runInContext('playing()', ctx), true);
  handler({ json: { c: 'stop', t: Date.now() + 10 } }); assert.equal(vm.runInContext('playing()', ctx), false);
});

// The widget's exec sources run the way the server runs them (sh -c with HATCH_ARG), against a temp state dir.
const source = (name, arg, state) => {
  const w = JSON.parse(fs.readFileSync(path.join(path.dirname(NOISE), 'widget.json'), 'utf8'));
  const cmd = w.sources.find((s) => s.name === name).cmd.replaceAll('{{state}}', state).replaceAll('{{widget}}', 'noise');
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', cmd], { env: { ...process.env, HATCH_ARG: arg ?? '' } });
    let out = ''; let err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (status) => resolve({ status, out, err }));
  });
};

test('noise sources: beat writes the playing note, last reports it with its age, idle removes it, bad input is refused', async () => {
  const state = tmp(); const note = path.join(state, 'widgets/noise/data/playing');
  assert.equal((await source('last', '', state)).out, '{}', 'nothing playing');
  assert.equal((await source('beat', 'rain.0', state)).status, 0);
  let r = JSON.parse((await source('last', '', state)).out); assert.equal(r.c, 'rain'); assert.equal(r.e, 0); assert.ok(r.age >= 0 && r.age < 5);
  const old = new Date(Date.now() - 600000); fs.utimesSync(note, old, old);
  r = JSON.parse((await source('last', '', state)).out); assert.ok(r.age >= 599, 'age comes from the file time, so a stale note reads as old');
  for (const bad of ['loud.1', 'brown', 'brown.x', 'brown.1; rm -rf x', '']) assert.equal((await source('beat', bad, state)).status, 1, `refuses ${bad}`);
  fs.writeFileSync(note, 'brown.12; echo hi'); assert.equal((await source('last', '', state)).out, '{}', 'a hand-edited bad note is ignored');
  assert.equal((await source('idle', '', state)).status, 0); assert.ok(!fs.existsSync(note));
});

test('noise widget: resumes a recent heartbeat with the remaining sleep time, ignores stale or expired ones, beats while playing and clears on stop', async () => {
  const script = [...fs.readFileSync(NOISE, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  const run = async (last, audio = 'running') => {
    const el = () => ({ textContent: '', value: '40', children: [], dataset: {}, classList: { toggle() {} }, appendChild() {}, options: [{ value: '0' }, { value: '15' }] });
    const els = new Map(); const dom = { getElementById: (id) => { if (!els.has(id)) els.set(id, el()); return els.get(id); }, createElement: el };
    const calls = []; let played = 0;
    const hatch = { ready() {}, on() {}, call: async (s, a) => { calls.push([s, a]); return { json: s === 'last' ? last : [] }; } };
    class AudioContext { get state() { return audio; } resume() {} createGain() { return { gain: {}, connect() {}, disconnect() {} }; } createBuffer() { return { getChannelData: () => new Float32Array(1) }; }
      createBufferSource() { return { start() { played++; }, stop() {}, connect() {}, disconnect() {} }; } get destination() { return {}; } get sampleRate() { return 1; } }
    const timers = [];
    const c = vm.createContext({ hatch, document: dom, AudioContext, location: { hash: '' }, addEventListener() {}, setInterval: (f, ms) => timers.push([f, ms]), clearInterval() {}, setTimeout: (f) => f(), Date, Math, Float32Array, Promise });
    vm.runInContext(script, c); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    return { c, calls, played: () => played, els, timers };
  };
  const in10min = Date.now() + 600000;
  let t = await run({ c: 'brown', e: in10min, age: 20 });
  assert.equal(t.played(), 1); assert.equal(vm.runInContext('type', t.c), 'brown'); assert.equal(vm.runInContext('endsAt', t.c), in10min, 'keeps the running sleep timer');
  assert.ok(t.calls.some(([s, a]) => s === 'beat' && a === `brown.${in10min}`), 'beats right away');
  assert.ok(t.timers.some(([, ms]) => ms === 30000), 'and keeps beating');
  vm.runInContext('stop(); render()', t.c); assert.ok(t.calls.some(([s]) => s === 'idle'), 'stop clears the note');
  t = await run({ c: 'pink', e: 0, age: 20 }); assert.equal(t.played(), 1); assert.equal(vm.runInContext('endsAt', t.c), 0, 'no timer stays no timer');
  t = await run({ c: 'pink', e: 0, age: 7200 }); assert.equal(t.played(), 0, 'a stale note (reboot, long suspend) does not play');
  t = await run({ c: 'pink', e: Date.now() - 1000, age: 20 }); assert.equal(t.played(), 0, 'a timer that has run out does not play');
  t = await run({}); assert.equal(t.played(), 0); assert.ok(!t.calls.some(([s]) => s === 'beat' || s === 'idle'), 'idle page sends nothing');
  t = await run({ c: 'pink', e: 0, age: 20 }, 'suspended');
  assert.equal(vm.runInContext('playing()', t.c), false); assert.match(t.els.get('sub').textContent, /click Play/);
});
