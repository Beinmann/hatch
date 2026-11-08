import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWatches, checkWatches, stripAnsi } from '../src/watches.js';
import { startHatch, tmp, waitFor, readSse } from './helpers.js';

test('stripAnsi removes colours, cursor moves and OSC titles', () => {
  assert.equal(stripAnsi('\x1b[31mFAIL\x1b[0m \x1b]0;title\x07ok\x1b[2K\r'), 'FAIL ok');
});

test('checkWatches validates entries', () => {
  const r = checkWatches([{ name: 'a', pattern: 'x' }, { name: 'b' }, { name: 'c', pattern: '(' }, { pattern: 'x' }, { name: 'i', idleSec: 5 }]);
  assert.deepEqual(r.defs.map((d) => d.name), ['a', 'i']); assert.equal(r.errors.length, 3);
  assert.equal(checkWatches({}).errors.length, 1);
});

test('pattern watches fire once per cooldown across chunk boundaries; idle fires once after quiet', () => {
  const file = path.join(tmp(), 'w.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'fail', pattern: 'build failed', level: 'warn', cooldownSec: 10 }, { name: 'idle', idleSec: 5 }]));
  let t = 1000; const got = [];
  const w = createWatches({ file, notify: (n) => got.push(n), now: () => t, tickMs: 1e9 });
  w.feed(Buffer.from('compiling...\x1b[31m build fa')); assert.equal(got.length, 0);
  w.feed(Buffer.from('iled\x1b[0m\n')); assert.equal(got.length, 1); assert.equal(got[0].level, 'warn');
  t += 2000; w.feed(Buffer.from('BUILD FAILED again\n')); assert.equal(got.length, 1, 'cooldown');
  t += 12000; w.tick(); assert.equal(got.length, 2); assert.match(got[1].text, /no terminal output for 5s/);
  w.tick(); assert.equal(got.length, 2, 'idle fires once');
  t += 1000; w.feed(Buffer.from('x')); t += 40000; w.tick(); assert.equal(got.length, 3, 'idle re-arms after new output');
  w.close();
});

test('a bad watches.json warns and does not break feeding', () => {
  const file = path.join(tmp(), 'w.json'); fs.writeFileSync(file, '{nope'); const warns = [];
  const w = createWatches({ file, notify() {}, warn: (m) => warns.push(m), tickMs: 1e9 });
  w.feed(Buffer.from('hi')); assert.match(warns[0], /invalid JSON/); w.close();
});

test('end to end: terminal output matching a watch reaches the event stream as a notify', async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('PUT', '/api/watches', [{ name: 'magic', pattern: 'abracadabra', level: 'done' }])).status, 200);
    assert.equal((await h.call('PUT', '/api/watches', [{ name: 'bad', pattern: '(' }])).status, 400);
    await h.call('GET', '/api/term');
    const got = readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'notify'), 5000);
    await new Promise((r) => setTimeout(r, 300));
    await h.call('POST', '/api/term/input', { data: 'abracadabra\n' });
    assert.match((await got).find((x) => x.event === 'notify').data, /abracadabra/);
  } finally { await h.close(); }
});

test('watches decode split UTF-8 and escapes without matching hidden title contents', () => {
  const dir = tmp(); const file = path.join(dir, 'w.json'); const got = [];
  fs.writeFileSync(file, JSON.stringify([
    { name: 'unicode', pattern: '完成', cooldownSec: 1 },
    { name: 'hidden', pattern: 'secret error', cooldownSec: 1 },
    { name: 'first', pattern: 'build failed', cooldownSec: 1 },
    { name: 'second', pattern: 'build failed', cooldownSec: 1 },
  ]));
  const w = createWatches({ file, notify: n => got.push(n), now: () => 1000, tickMs: 1e9 });
  try {
    const bytes = Buffer.from('完成\x1b]0;secret error\x1b\\build \x1b[31mfailed\x1b[0m');
    for (const byte of bytes) w.feed(Buffer.from([byte]));
    assert.deepEqual(got.map(n => n.text), ['unicode: 完成', 'first: build failed', 'second: build failed']);
  } finally { w.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watch matches include large chunk beginnings and consume old matches independently', () => {
  const dir = tmp(); const file = path.join(dir, 'w.json'); const got = []; let time = 1000;
  fs.writeFileSync(file, JSON.stringify([{ name: 'one', pattern: 'FAIL', cooldownSec: 1 }, { name: 'two', pattern: 'FAIL', cooldownSec: 1 }]));
  const w = createWatches({ file, notify: n => got.push(n), now: () => time, tickMs: 1e9 });
  try {
    w.feed(Buffer.from('FAIL FAIL ' + 'x'.repeat(10000))); assert.equal(got.length, 2);
    time += 2000; w.feed(Buffer.from('unrelated')); assert.equal(got.length, 2);
    w.feed(Buffer.from(' FAIL')); assert.equal(got.length, 4);
  } finally { w.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('invalid watch edits keep valid definitions active and idle watches support a zero-based clock', () => {
  const dir = tmp(); const file = path.join(dir, 'w.json'); const got = []; const warnings = []; let time = 0; let stamp = 1700000000;
  const write = (text) => { fs.writeFileSync(file, text); fs.utimesSync(file, ++stamp, stamp); };
  write(JSON.stringify([{ name: 'match', pattern: 'ready', cooldownSec: 1 }, { name: 'idle', idleSec: 1 }]));
  const w = createWatches({ file, notify: n => got.push(n), warn: m => warnings.push(m), now: () => time, tickMs: 1e9 });
  try {
    w.feed(Buffer.from('start')); time = 1000; w.tick(); assert.match(got[0].text, /no terminal output/);
    write('{broken'); w.feed(Buffer.from('ready')); assert.equal(got[1].text, 'match: ready'); assert.match(warnings.at(-1), /invalid JSON/);
    write('[{"name":"bad","pattern":"("}]'); time += 2000; w.feed(Buffer.from('ready')); assert.equal(got.at(-1).text, 'match: ready'); assert.match(warnings.at(-1), /bad:/);
    write('[]'); w.load(); assert.equal(warnings.at(-1), null); assert.deepEqual(w.defs(), []);
  } finally { w.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
