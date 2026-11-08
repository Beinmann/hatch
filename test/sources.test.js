import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCpu, cpuPct, parseMem, parseLoad, parseNet, checkSource, createSources } from '../src/sources.js';
import { tmp, sleep, waitFor } from './helpers.js';

const STAT1 = 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n';
const STAT2 = 'cpu  200 0 200 900 0 0 0 0 0 0\ncpu0 100 0 100 450 0 0 0 0 0 0\ncpu1 100 0 100 450 0 0 0 0 0 0\n';

test('cpu percentage from /proc/stat deltas', () => {
  const r = cpuPct(parseCpu(STAT1), parseCpu(STAT2));
  assert.equal(r.total, 66.7); assert.equal(r.cores.length, 2);
  assert.equal(cpuPct(null, parseCpu(STAT1)).total, 0);
});
test('mem, load and net parsers', () => {
  const m = parseMem('MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n');
  assert.equal(m.pct, 75); assert.equal(m.swapUsed, 60 * 1024);
  assert.deepEqual(parseLoad('0.5 1.5 2.5 1/200 999\n'), { l1: 0.5, l5: 1.5, l15: 2.5 });
  const n = parseNet('Inter-|   Receive\n face |bytes\n    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: 100 1 0 0 0 0 0 0 50 1 0 0 0 0 0 0\n');
  assert.deepEqual(n, { rx: 100, tx: 50 });
});
test('checkSource validates and clamps', () => {
  assert.match(checkSource({ kind: 'metric', id: 'nope' }).error, /unknown metric/);
  assert.equal(checkSource({ kind: 'exec', cmd: 'x', everyMs: 10 }).def.everyMs, 500);
  assert.match(checkSource({ kind: 'weird' }).error, /unknown source kind/);
  assert.match(checkSource({ kind: 'tail' }).error, /path/);
});

test('metric source reads a fake /proc and is shared; sampler stops with the last subscriber', async () => {
  const root = tmp(); fs.writeFileSync(path.join(root, 'loadavg'), '1 2 3 1/1 1\n');
  const src = createSources({ procRoot: root });
  const a = []; const b = [];
  const offA = src.subscribe({ kind: 'metric', id: 'load', everyMs: 500 }, (v) => a.push(v));
  const offB = src.subscribe({ kind: 'metric', id: 'load', everyMs: 500 }, (v) => b.push(v));
  assert.equal(src.active(), 1);
  await waitFor(() => a.length && b.length);
  assert.equal(a[0].l5, 2);
  offA(); assert.equal(src.active(), 1); offB(); assert.equal(src.active(), 0);
});

test('exec source runs a command, parses JSON, reports errors', async () => {
  const src = createSources(); const got = [];
  const off = src.subscribe({ kind: 'exec', cmd: 'echo \'{"a":1}\'', json: true, everyMs: 500, timeoutMs: 3000 }, (v) => got.push(v));
  await waitFor(() => got.length); off();
  assert.deepEqual(got[0].json, { a: 1 });
  const bad = []; const off2 = src.subscribe({ kind: 'exec', cmd: 'echo nope >&2; exit 3', everyMs: 500, timeoutMs: 3000 }, (v) => bad.push(v));
  await waitFor(() => bad.length); off2();
  assert.equal(bad[0].code, 3); assert.match(bad[0].error, /nope/);
});

test('tail source replays the buffer to late subscribers and then streams appends', async () => {
  const f = path.join(tmp(), 'log.txt'); fs.writeFileSync(f, 'one\ntwo\n');
  const src = createSources(); const early = []; const late = [];
  const off = src.subscribe({ kind: 'tail', path: f, everyMs: 500 }, (v) => early.push(v));
  await waitFor(() => early.length);
  const off2 = src.subscribe({ kind: 'tail', path: f, everyMs: 500 }, (v) => late.push(v));
  assert.deepEqual(late[0].lines, ['one', 'two']); assert.equal(late[0].append, false);
  fs.appendFileSync(f, 'three\n');
  await waitFor(() => early.some((v) => v.lines?.includes('three')));
  off(); off2(); await sleep(10);
});

test('file source emits whole file text on change', async () => {
  const f = path.join(tmp(), 'a.txt'); fs.writeFileSync(f, 'v1');
  const src = createSources(); const got = [];
  const off = src.subscribe({ kind: 'file', path: f, everyMs: 500 }, (v) => got.push(v));
  await waitFor(() => got.length); assert.equal(got[0].text, 'v1');
  off();
});

test('ports metric reads a fake /proc and is a valid source', () => {
  assert.equal(checkSource({ kind: 'metric', id: 'ports' }).def.id, 'ports');
  const root = tmp(); fs.mkdirSync(path.join(root, 'net'));
  fs.writeFileSync(path.join(root, 'net/tcp'), 'hdr\n   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1\n');
  const src = createSources({ procRoot: root }); const got = [];
  const off = src.subscribe({ kind: 'metric', id: 'ports', everyMs: 500 }, (v) => got.push(v));
  return waitFor(() => got.length).then(() => { off(); assert.deepEqual(got[0].ports.map((p) => p.port), [3000]); });
});

test('tail of a missing file reports a readable error once, then recovers when the file appears', async () => {
  const f = path.join(tmp(), 'later.log');
  const src = createSources(); const got = [];
  const off = src.subscribe({ kind: 'tail', path: f, everyMs: 500 }, (v) => got.push(v));
  await waitFor(() => got.length);
  assert.match(got[0].error, /cannot read .*later\.log: the file does not exist/); assert.doesNotMatch(got[0].error, /^cannot read \S+: ENOENT/);
  fs.writeFileSync(f, 'hello\n');
  await waitFor(() => got.some((v) => v.lines?.includes('hello')), 3000);
  assert.equal(got.filter((v) => v.error).length, 1);
  off(); await sleep(10);
});
