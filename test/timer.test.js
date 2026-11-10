import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startHatch } from './helpers.js';

const EXAMPLES = fileURLToPath(new URL('../examples/widgets/', import.meta.url));

// A permissive stand-in for any DOM object: every property is another stand-in, calling it returns one.
const dom = () => new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => '' : k === 'children' ? [] : k === 'length' ? 0 : dom()), apply: () => dom(), set: () => true });

/** Runs a widget's inline script the way the page does: hatch.call goes to the real /api/call and resolves with r.value,
 *  exactly what the host hands the widget (an object { out, code, json?, error? }, not the bare JSON). */
function runWidget(name, h, ids) {
  const html = fs.readFileSync(path.join(EXAMPLES, name, 'index.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
  const logs = []; let ready;
  const hatch = {
    ready: (fn) => { ready = fn; },
    call: async (source, arg) => {
      const r = await h.call('POST', '/api/call', { widget: name, source, ...(arg !== undefined && { arg: String(arg) }) });
      if (r.status !== 200) throw new Error(r.data.error); return r.data.value;
    },
    log: (t) => logs.push(t),
  };
  const sandbox = { hatch, console, Date, Math, Promise, Map, Set, Number, String, RegExp, Array, Object, parseInt, parseFloat, isNaN,
    setInterval: () => 0, setTimeout, clearTimeout, addEventListener: () => {}, localStorage: undefined,
    document: { getElementById: () => dom(), createElement: () => dom(), body: dom() }, ...Object.fromEntries(ids.map((i) => [i, dom()])) };
  const ctx = vm.createContext(sandbox); vm.runInContext(script, ctx);
  return { ctx, logs, start: () => ready(), eval: (code) => vm.runInContext(code, ctx) };
}

const settle = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('timer example: put and list through /api/call keep a running timer, and a reloaded widget sees it again', async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/examples/timer/open', {})).status, 200);
    const data = path.join(h.stateDir, 'widgets', 'timer', 'data');
    const call = (source, arg) => h.call('POST', '/api/call', { widget: 'timer', source, arg });
    const end = Date.now() + 3600e3; const file = `abc1.600000.${Date.now()}.${end}.r.lunch.t`;
    let r = await call('put', file); assert.equal(r.data.value.code, 0, r.data.value.error); assert.deepEqual(fs.readdirSync(data), [file]);
    r = await call('list', undefined); assert.deepEqual(r.data.value.json, [file], 'list answers { json: [names] }, not a bare array');

    // the widget as a fresh page load: the first run saves a timer, a second run (the reload) must show it
    const first = runWidget('timer', h, ['grid']); first.start();
    first.eval('add(300000, "tea")'); await settle(() => fs.readdirSync(data).length === 2);
    assert.equal(fs.readdirSync(data).length, 2, `put wrote the new timer: ${fs.readdirSync(data)}`);
    const second = runWidget('timer', h, ['grid']); second.start();
    await settle(() => second.eval('loaded'));
    assert.equal(second.eval('timers.length'), 2, 'both timers come back after a reload');
    assert.equal(second.eval('JSON.stringify(timers.map((t) => t.label).sort())'), '["lunch","tea"]');
    assert.deepEqual(second.logs, []);
  } finally { await h.close(); }
});

test('pomodoro example: its saved state comes back after a reload', async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/examples/pomodoro/open', {})).status, 200);
    const data = path.join(h.stateDir, 'widgets', 'pomodoro', 'data'); fs.mkdirSync(data, { recursive: true });
    const w = runWidget('pomodoro', h, ['go', 'skip', 'reset', 'cfg', 'au', 'lf', 'ls', 'll', 'sub', 'bar', 't']);
    const today = w.eval('today()');
    const v = Date.now() + 1200e3; fs.writeFileSync(path.join(data, `s.f.${v}.r.2.${today}.25.5.15.1.t`), '');
    w.start(); await settle(() => w.eval('loaded'));
    assert.equal(w.eval('S.mode'), 'f'); assert.equal(w.eval('S.st'), 'r'); assert.equal(w.eval('S.done'), 2);
  } finally { await h.close(); }
});
