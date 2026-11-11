import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { startHatch, tmp } from './helpers.js';
import { createHatch } from '../src/server.js';
import { createConfigGuard } from '../src/config-guard.js';

const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return fn(); };
const fast = { intervalMs: 20, minGapMs: 0 };
const cfgOf = (h) => JSON.parse(fs.readFileSync(path.join(h.stateDir, 'config.json'), 'utf8'));
const logOf = (h) => { try { return fs.readFileSync(path.join(h.stateDir, 'log', 'server.log'), 'utf8'); } catch { return ''; } };
const edit = (h, f) => { const file = path.join(h.stateDir, 'config.json'); fs.writeFileSync(file, JSON.stringify(f(cfgOf(h)), null, 2)); };

test('repairs only port and host, keeps hand edits and the token, logs a warning', async () => {
  const h = await startHatch({ configGuard: fast });
  try {
    const token = cfgOf(h).token;
    edit(h, (c) => ({ ...c, port: 1, host: '10.9.9.9', viewToken: 'v'.repeat(20), allowedHosts: ['box.example'], custom: { a: 1 } }));
    assert.ok(await until(() => cfgOf(h).port === h.port), 'port restored');
    const c = cfgOf(h);
    assert.equal(c.host, '127.0.0.1'); assert.equal(c.token, token); assert.equal(c.viewToken, 'v'.repeat(20));
    assert.deepEqual(c.allowedHosts, ['box.example']); assert.deepEqual(c.custom, { a: 1 });
    assert.match(logOf(h), /WARNING config guard: .*restored port and host only/);
  } finally { await h.close(); }
});

test('a missing or unparseable config.json is left alone and logged once', async () => {
  const h = await startHatch({ configGuard: fast });
  try {
    const file = path.join(h.stateDir, 'config.json');
    fs.writeFileSync(file, '{ not json');
    assert.ok(await until(() => /missing or not valid JSON/.test(logOf(h))));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
    assert.equal(logOf(h).match(/missing or not valid JSON/g).length, 1);
    fs.rmSync(file); await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(file), false, 'not recreated');
  } finally { await h.close(); }
});

test('follows a re-listen on another port (retry after EADDRINUSE)', async () => {
  const dir = tmp(); const blocker = net.createServer(); await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const hatch = createHatch({ stateDir: path.join(dir, '.hatch'), host: '127.0.0.1', port: blocker.address().port, attach: ['cat'], cwd: dir, findBin: () => null, configGuard: fast });
  const h = { stateDir: path.join(dir, '.hatch') };
  try {
    await assert.rejects(hatch.listen(), { code: 'EADDRINUSE' });
    assert.equal(hatch.configGuardRunning, false, 'not started before a successful listen');
    const p2 = await hatch.listen(0);
    edit(h, (c) => ({ ...c, port: 1 }));
    assert.ok(await until(() => cfgOf(h).port === p2));
  } finally { await hatch.close(); blocker.close(); }
});

test('does nothing when another live process owns the lock', async () => {
  const h = await startHatch({ configGuard: fast });
  const fake = spawn('node', ['-e', 'setTimeout(()=>{},20000)', 'hatch-server']);
  try {
    const lockFile = path.join(h.stateDir, 'server.lock');
    const start = fs.readFileSync(`/proc/${fake.pid}/stat`, 'utf8'); const st = start.slice(start.lastIndexOf(')') + 2).split(' ')[19];
    fs.writeFileSync(lockFile, JSON.stringify({ pid: fake.pid, start: st, port: 5, host: 'x' }));
    edit(h, (c) => ({ ...c, port: 1 }));
    assert.ok(await until(() => /another Hatch server \(pid \d+\) owns/.test(logOf(h))));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(cfgOf(h).port, 1, 'not repaired');
    assert.equal(logOf(h).match(/another Hatch server/g).length, 1);
  } finally { fake.kill('SIGKILL'); fs.rmSync(path.join(h.stateDir, 'server.lock'), { force: true }); await h.close(); }
});

test('repeat limit pauses repairs; the clock and min gap are injectable', async () => {
  const h = await startHatch();
  try {
    let t = 1000; const lines = [];
    const g = createConfigGuard({ stateDir: h.stateDir, current: () => ({ port: h.port, host: '127.0.0.1' }), log: (m) => lines.push(m), minGapMs: 5000, maxRepairs: 5, windowMs: 60000, now: () => t });
    const clobber = () => edit(h, (c) => ({ ...c, port: 1 }));
    clobber(); g.check(); assert.equal(cfgOf(h).port, h.port);
    clobber(); t += 1000; g.check(); assert.equal(cfgOf(h).port, 1, 'within min gap: no repair');
    for (let i = 0; i < 4; i++) { t += 6000; g.check(); assert.equal(cfgOf(h).port, h.port); clobber(); }
    t += 6000; g.check(); assert.equal(cfgOf(h).port, 1, 'sixth repair within a minute is refused');
    g.check(); assert.equal(lines.filter((l) => /another process keeps rewriting/.test(l)).length, 1);
    t += 61000; g.check(); assert.equal(cfgOf(h).port, h.port, 'resumes after the window');
  } finally { await h.close(); }
});

test('close() stops the timer and the interval is unref()ed', async () => {
  const h = await startHatch({ configGuard: fast });
  try { assert.equal(h.hatch.configGuardRunning, true); } finally { await h.close(); }
  assert.equal(h.hatch.configGuardRunning, false);
  edit(h, (c) => ({ ...c, port: 1 })); await new Promise((r) => setTimeout(r, 120));
  assert.equal(cfgOf(h).port, 1, 'no repair after close');
  const g = createConfigGuard({ stateDir: h.stateDir, current: () => ({}) }); g.start();
  assert.equal(g.running, true); g.stop(); assert.equal(g.running, false);
});
