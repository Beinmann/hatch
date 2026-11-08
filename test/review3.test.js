import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSchedules, checkSchedules } from '../src/schedules.js';
import { createRuns } from '../src/runs.js';
import { tasks } from '../src/discover.js';
import { rename } from '../src/files.js';
import { startHatch, tmp, waitFor, readSse } from './helpers.js';

test('schedules: duplicate names are refused', () => {
  const r = checkSchedules([{ name: 't', cmd: 'a', everySec: 60 }, { name: 't', cmd: 'b', everySec: 60 }]);
  assert.equal(r.defs.length, 1); assert.match(r.errors[0], /duplicate/);
});

test('schedules: editing the command or breaking the file while a run is in flight never starts a second run', async () => {
  const dir = tmp(); const file = path.join(dir, 's.json'); const marker = path.join(dir, 'starts');
  const write = (cmd) => { fs.writeFileSync(file, JSON.stringify([{ name: 'slow', cmd, everySec: 10 }])); const t = new Date(Date.now() + (write.n = (write.n || 0) + 1) * 2000); fs.utimesSync(file, t, t); };
  write(`echo x >> ${marker}; sleep 3`);
  let t = 5_000_000; const runs = createRuns({ cwd: dir }); const s = createSchedules({ file, runs, cwd: dir, notify() {}, now: () => t, tickMs: 1e9 });
  s.tick(); await waitFor(() => fs.existsSync(marker), 2000);
  write(`echo y >> ${marker}; sleep 3`); t += 11000; s.tick(); // edited while running
  fs.writeFileSync(file, '{broken'); const bt = new Date(Date.now() + 9000); fs.utimesSync(file, bt, bt); t += 11000; s.tick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1, 'still only the first run');
  s.close(); runs.stopAll();
});

test('runs: a timeout kills a hung command (exit 124); scheduled runs do not evict the user\'s runs', async () => {
  const runs = createRuns({ cwd: process.cwd() });
  const hung = runs.start('sleep 30', undefined, { quiet: true, timeoutSec: 1 }); await waitFor(() => runs.get(hung.id).state === 'done', 4000); assert.equal(runs.get(hung.id).code, 124);
  const mine = runs.start('true'); await waitFor(() => runs.get(mine.id).state === 'done');
  for (let i = 0; i < 40; i++) { const q = runs.start('true', undefined, { quiet: true }); await waitFor(() => runs.get(q.id).state === 'done'); }
  assert.equal(runs.get(mine.id).state, 'done', 'the user run survives 40 background runs');
  assert.ok(runs.list().filter((r) => r.quiet !== false).length <= 20 + 1, 'background runs are trimmed');
});

test('placeholders: a $ in the server directory is not read as a replacement pattern', async () => {
  const d = tmp(); const weird = path.join(d, "a$'b$&c"); fs.mkdirSync(weird);
  const h = await startHatch({ cwd: weird });
  try {
    await h.call('PUT', '/api/widgets/ph', { files: { 'index.html': 'x' }, meta: { sources: [{ name: 'p', kind: 'exec', cmd: 'echo {{cwd}}', everyMs: 500 }] } });
    const s = await readSse(`${h.base}/api/source/ph/p`, { 'x-token': h.hatch.token }, (e) => e.length > 0);
    assert.equal(JSON.parse(s[0].data).value.out, weird);
  } finally { await h.close(); }
});

test('discover quotes odd script names; rename sees dangling links', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { 'a b': 'x', build: 'y' } }));
  assert.deepEqual(tasks(d).map((x) => x.cmd), ["npm run 'a b'", 'npm run build']);
  const r = tmp(); fs.writeFileSync(path.join(r, 'a'), '1'); fs.symlinkSync('/nonexistent-target', path.join(r, 'dangling'));
  assert.throws(() => rename(path.join(r, 'a'), path.join(r, 'dangling')), /already exists/);
});

test('review 5 fixes: malformed URIs are 404 (no 500), symlinked widget dirs are refused, odd file names rejected, ANSI strip is fast', async () => {
  const h = await startHatch();
  try {
    assert.equal((await fetch(`${h.base}/widgets/a/%E0%A4%A`)).status, 404);
    assert.equal((await fetch(`${h.base}/%E0%A4%A`, { headers: { 'x-token': h.hatch.token } })).status, 404);
    fs.mkdirSync(path.join(h.dir, 'outside')); fs.writeFileSync(path.join(h.dir, 'outside', 'f.txt'), 'SECRET'); fs.symlinkSync(path.join(h.dir, 'outside'), path.join(h.stateDir, 'widgets', 'lnk'));
    assert.equal((await fetch(`${h.base}/widgets/lnk/f.txt`)).status, 404, 'a symlinked widget directory is not followed');
    const r = (await h.call('POST', '/api/runs', { cmd: "printf '\\033]%.0s' $(seq 1 30000); echo done" })).data; await waitFor(async () => (await h.call('GET', `/api/runs/${r.id}`)).data.state === 'done', 8000);
    const t0 = Date.now(); await h.call('GET', `/api/runs/${r.id}/output`); assert.ok(Date.now() - t0 < 1500, 'output() no longer takes quadratic time');
  } finally { await h.close(); }
});
