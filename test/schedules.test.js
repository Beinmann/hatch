import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSchedules, checkSchedules, parseEvery } from '../src/schedules.js';
import { createRuns } from '../src/runs.js';
import { tmp, waitFor, startHatch } from './helpers.js';

test('parseEvery and checkSchedules', () => {
  assert.equal(parseEvery('30s'), 30); assert.equal(parseEvery('5m'), 300); assert.equal(parseEvery('2h'), 7200); assert.equal(parseEvery('45'), 45); assert.equal(parseEvery('soon'), null);
  const r = checkSchedules([{ name: 'a', cmd: 'true', everySec: 60 }, { name: 'b', cmd: 'true', everySec: 2 }, { cmd: 'x', everySec: 60 }, { name: 'c', everySec: 60 }]);
  assert.deepEqual(r.defs.map((d) => d.name), ['a']); assert.equal(r.errors.length, 3); assert.equal(checkSchedules({}).errors.length, 1);
});

test('notifies when status changes, not on every run; first failure notifies; always mode notifies each time', async () => {
  const dir = tmp(); const file = path.join(dir, 's.json'); const flag = path.join(dir, 'fail');
  fs.writeFileSync(file, JSON.stringify([{ name: 'tests', cmd: `test ! -e ${flag}`, everySec: 10 }, { name: 'loud', cmd: 'true', everySec: 10, always: true }]));
  let t = 1_000_000; const got = []; const runs = createRuns({ cwd: dir, notify: (n) => got.push(`RUN ${n.text}`) });
  const s = createSchedules({ file, runs, cwd: dir, notify: (n) => got.push(n.text), now: () => t, tickMs: 1e9 });
  const cycle = async () => { s.tick(); await waitFor(() => s.status().every((x) => !x.running), 3000); t += 11000; };
  await cycle(); assert.deepEqual(got.filter((x) => !x.startsWith('RUN')), ['loud: passed'], 'a passing first run is silent unless always');
  await cycle(); assert.equal(got.filter((x) => x === 'loud: passed').length, 2);
  fs.writeFileSync(flag, ''); await cycle(); assert.ok(got.includes('tests: failed (exit 1)'), 'green to red notifies');
  const before = got.filter((x) => x.startsWith('tests:')).length; await cycle(); assert.equal(got.filter((x) => x.startsWith('tests:')).length, before, 'still failing: silent');
  fs.rmSync(flag); await cycle(); assert.ok(got.includes('tests: passing again'), 'red to green notifies');
  assert.equal(got.some((x) => x.startsWith('RUN')), false, 'scheduled runs do not add their own finished notifications');
  s.close();
});

test('schedule API and CLI-shaped flow; bad definitions are 400', async () => {
  const h = await startHatch();
  try {
    assert.deepEqual((await h.call('GET', '/api/schedules')).data, []);
    assert.equal((await h.call('PUT', '/api/schedules', [{ name: 'x', cmd: 'true', everySec: 3 }])).status, 400);
    const ok = await h.call('PUT', '/api/schedules', [{ name: 'x', cmd: 'true', everySec: 60 }]); assert.equal(ok.status, 200); assert.equal(ok.data[0].name, 'x');
    await waitFor(async () => (await h.call('GET', '/api/schedules')).data[0].last !== null, 4000);
    assert.equal((await h.call('GET', '/api/schedules')).data[0].last.code, 0);
    fs.writeFileSync(path.join(h.stateDir, 'schedules.json'), '{x'); await new Promise((r) => setTimeout(r, 1300));
    assert.ok(h.hatch.state.snapshot().warnings.some((w) => w.file === 'schedules.json'));
  } finally { await h.close(); }
});

test('schedule validation rejects infinite intervals and unrepresentable parsed durations', () => {
  for (const everySec of [Infinity, 'Infinity', NaN, 'NaN', 1e308]) assert.equal(checkSchedules([{ name: 'invalid', cmd: 'true', everySec }]).defs.length, 0);
  assert.equal(parseEvery('9'.repeat(400) + 'h'), null);
  assert.equal(parseEvery('999999999999999999h'), null);
  assert.equal(parseEvery('30d'), null);
  assert.equal(checkSchedules([{ name: 'monthly', cmd: 'true', everySec: 30 * 86400 }]).errors.length, 0);
});

test('removing and restoring schedules keeps in-flight runs unique and ignores obsolete completion alerts', () => {
  const dir = tmp(); const file = path.join(dir, 's.json'); const callbacks = []; const notices = []; let time = 1000; let stamp = 1700000000;
  const definition = [{ name: 'check', cmd: 'command', everySec: 10, always: true }];
  const write = (defs) => { fs.writeFileSync(file, JSON.stringify(defs)); fs.utimesSync(file, ++stamp, stamp); };
  write(definition);
  const schedules = createSchedules({ file, cwd: dir, now: () => time, tickMs: 1e9, notify: n => notices.push(n), runs: { start: (cmd, cwd, options) => callbacks.push(options.onDone) } });
  try {
    schedules.tick(); assert.equal(callbacks.length, 1);
    fs.unlinkSync(file); schedules.tick(); assert.deepEqual(schedules.status(), []);
    time += 20000; write(definition); schedules.tick(); assert.equal(callbacks.length, 1); assert.equal(schedules.status()[0].running, true);
    callbacks[0](0, { id: 'first' }); assert.equal(notices.length, 1); assert.equal(schedules.status()[0].last.runId, 'first');
    schedules.tick(); assert.equal(callbacks.length, 2);
    write([]); callbacks[1](1, { id: 'removed' }); assert.equal(notices.length, 1);
    write(definition); schedules.tick(); assert.equal(callbacks.length, 3);
    schedules.close(); callbacks[2](1, { id: 'closed' }); time += 20000; schedules.tick(); assert.equal(callbacks.length, 3); assert.equal(notices.length, 1);
  } finally { schedules.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
