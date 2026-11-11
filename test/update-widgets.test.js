import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateWidgets } from '../src/update-widgets.js';

test('update-widgets replaces widget files, keeps data/, backs up local edits, skips unused widgets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-uw-'));
  const w = path.join(dir, 'widgets', 'background-roulette');
  fs.mkdirSync(path.join(w, 'data'), { recursive: true });
  fs.writeFileSync(path.join(w, 'index.html'), 'old');
  fs.writeFileSync(path.join(w, 'data', 'a.jpg'), 'img');
  const r = updateWidgets(dir, null);
  assert.deepEqual(r.updated.map((u) => u.name), ['background-roulette']);
  assert.ok(r.missing.includes('clock'));
  assert.notEqual(fs.readFileSync(path.join(w, 'index.html'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(w, 'index.html.bak'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(w, 'data', 'a.jpg'), 'utf8'), 'img');
  assert.deepEqual(updateWidgets(dir, ['background-roulette']).unchanged, ['background-roulette']);
  assert.throws(() => updateWidgets(dir, ['nope']), /no example widget nope/);
});

test('stale check: recorded hash, edits, no record, and the /api/examples hint', async () => {
  const { widgetStatus, recordShipped, shippedHash } = await import('../src/update-widgets.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-uw-')); const w = path.join(dir, 'widgets', 'clock');
  assert.equal(widgetStatus(dir, 'clock'), 'unknown', 'not installed');
  fs.cpSync(new URL('../examples/widgets/clock', import.meta.url), w, { recursive: true });
  assert.equal(widgetStatus(dir, 'clock'), 'current'); assert.ok(fs.existsSync(path.join(dir, 'shipped-widgets.json')), 'an identical copy gets recorded');
  // edited on purpose, shipped unchanged: no warning
  fs.appendFileSync(path.join(w, 'index.html'), '\n<!-- mine -->'); assert.equal(widgetStatus(dir, 'clock'), 'current');
  // upstream moved (simulated by a record of an older shipped version): warns, edited or not
  const rec = path.join(dir, 'shipped-widgets.json'); fs.writeFileSync(rec, JSON.stringify({ clock: 'old' })); assert.equal(widgetStatus(dir, 'clock'), 'stale');
  // refreshing records the new version and clears the warning
  updateWidgets(dir, ['clock']); assert.equal(widgetStatus(dir, 'clock'), 'current'); assert.equal(JSON.parse(fs.readFileSync(rec, 'utf8')).clock, shippedHash('clock'));
  // no record: an untouched old copy is stale, a copy edited later is unknown (we cannot tell), a malformed record is ignored
  fs.rmSync(rec); fs.writeFileSync(path.join(w, 'index.html'), 'old shipped version'); const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(w, 'widget.json'), old, old); fs.utimesSync(path.join(w, 'index.html'), new Date(), new Date());
  assert.equal(widgetStatus(dir, 'clock'), 'unknown');
  fs.utimesSync(path.join(w, 'index.html'), old, old); assert.equal(widgetStatus(dir, 'clock'), 'stale');
  fs.writeFileSync(rec, '{not json'); assert.equal(widgetStatus(dir, 'clock'), 'stale');
  recordShipped(dir, 'clock'); assert.equal(JSON.parse(fs.readFileSync(rec, 'utf8')).clock, shippedHash('clock'), 'recording over a malformed file works');
});

test('opening an example records its hash; /api/examples flags only a stale installed copy', async () => {
  const { startHatch } = await import('./helpers.js');
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/examples/clock/open', {})).status, 200);
    const rec = path.join(h.stateDir, 'shipped-widgets.json'); assert.ok(JSON.parse(fs.readFileSync(rec, 'utf8')).clock);
    let list = (await h.call('GET', '/api/examples')).data; assert.equal(list.find((e) => e.name === 'clock').stale, undefined);
    fs.appendFileSync(path.join(h.stateDir, 'widgets/clock/index.html'), '\n<!-- old copy -->'); fs.writeFileSync(rec, JSON.stringify({ clock: 'older' }));
    list = (await h.call('GET', '/api/examples')).data;
    assert.equal(list.find((e) => e.name === 'clock').stale, true); assert.match(list.find((e) => e.name === 'clock').hint, /hatch-server update-widgets clock/);
    assert.equal(list.find((e) => e.name === 'cpu').stale, undefined, 'a widget this instance never copied is not flagged');
  } finally { await h.close(); }
});

test('per-project git copies: flagged when stale, refreshed by update-widgets git, project settings kept', async () => {
  const { staleProjectCopies, projectGitCopies, gitProjectMeta } = await import('../src/update-widgets.js');
  const ex = new URL('../examples/widgets/git', import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-uw-')); const w = path.join(dir, 'widgets', 'git-proj');
  fs.cpSync(ex, w, { recursive: true });
  // a copy made before the redesign: no from field, old log length and old page
  const shipped = JSON.parse(fs.readFileSync(new URL('../examples/widgets/git/widget.json', import.meta.url), 'utf8'));
  const old = gitProjectMeta(shipped, "/work/my'proj", 'Git: proj'); delete old.from; old.w = 700; old.sources[0].cmd = old.sources[0].cmd.replace('-n 5', '-n 12');
  fs.writeFileSync(path.join(w, 'widget.json'), JSON.stringify(old)); fs.writeFileSync(path.join(w, 'index.html'), 'old page');
  fs.mkdirSync(path.join(dir, 'widgets', 'unrelated')); fs.writeFileSync(path.join(dir, 'widgets', 'unrelated', 'widget.json'), '{"dir":"/x"}');
  assert.deepEqual(projectGitCopies(dir), ['git-proj']); assert.deepEqual(staleProjectCopies(dir), ['git-proj']);
  const r = updateWidgets(dir, ['git']);
  assert.deepEqual(r.updated.map((u) => u.name), ['git-proj']);
  const meta = JSON.parse(fs.readFileSync(path.join(w, 'widget.json'), 'utf8'));
  assert.equal(meta.dir, "/work/my'proj"); assert.equal(meta.title, 'Git: proj'); assert.equal(meta.w, 700); assert.equal(meta.from, 'git');
  assert.match(meta.sources[0].cmd, /-n 5/); assert.ok(meta.sources[0].cmd.includes(`cd '/work/my'\\''proj'`), 'cwd stays pinned and quoted');
  assert.equal(fs.readFileSync(path.join(w, 'index.html.bak'), 'utf8'), 'old page');
  assert.deepEqual(staleProjectCopies(dir), []); assert.deepEqual(updateWidgets(dir, ['git-proj']).unchanged, ['git-proj']);
  assert.equal(fs.existsSync(path.join(dir, 'widgets', 'git')), false, 'the plain git widget is not created');
});
