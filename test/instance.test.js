import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, findStateDir, makeClient } from '../src/find.js';
import { instanceNotice, shortPath, readOwner } from '../src/instance.js';
import { tmp } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const mkInstance = (dir, port = 7099) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, token: 'tok' })); return fs.realpathSync(dir); };
const tty = () => { const out = []; return { isTTY: true, write: (s) => out.push(s), out }; };
const deadPid = () => { let p = 4000000; while (true) { try { process.kill(p, 0); p++; } catch { return p; } } };

test('resolveStateDir reports how the instance was found', () => {
  const root = fs.realpathSync(tmp());
  const proj = path.join(root, 'proj'); const sub = path.join(proj, 'a', 'b'); fs.mkdirSync(sub, { recursive: true });
  const inst = mkInstance(path.join(proj, '.hatch'));
  const other = mkInstance(path.join(root, 'other'));
  const noHome = { HOME: path.join(root, 'nohome') };
  assert.deepEqual(resolveStateDir({ state: other, env: {}, cwd: sub }), { dir: other, how: 'flag', alternatives: [] });
  assert.deepEqual(resolveStateDir({ env: { HATCH_STATE: other }, cwd: root }), { dir: other, how: 'env', alternatives: [] });
  assert.deepEqual(resolveStateDir({ env: noHome, cwd: sub }), { dir: inst, how: 'walk', alternatives: [] });
  assert.equal(findStateDir({ env: noHome, cwd: sub }), inst);
  // conflict: HATCH_STATE wins but a nearer .hatch exists elsewhere
  assert.deepEqual(resolveStateDir({ env: { HATCH_STATE: other }, cwd: sub }), { dir: other, how: 'env', alternatives: [{ dir: inst, how: 'walk' }] });
  // an invalid HATCH_STATE falls through to the walk
  assert.equal(resolveStateDir({ env: { HATCH_STATE: path.join(root, 'nope') }, cwd: sub }).how, 'walk');
});

test('resolveStateDir finds ~/.hatch last', () => {
  const home = fs.realpathSync(tmp()); const inst = mkInstance(path.join(home, '.hatch'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-nowalk-'));
  const old = process.env.HOME; process.env.HOME = home;
  try {
    const r = resolveStateDir({ env: {}, cwd });
    // a stray .hatch above the temp dir would win the walk; only check the home case when there is none
    if (r.how === 'home') assert.equal(r.dir, inst); else assert.equal(r.how, 'walk');
  } finally { process.env.HOME = old; }
  assert.throws(() => resolveStateDir({ state: path.join(home, 'x') }), /no config.json/);
});

test('instance notice: once per shell, only when surprising, only on a TTY', () => {
  const stamps = tmp(); const root = fs.realpathSync(tmp());
  const a = mkInstance(path.join(root, 'a', '.hatch'), 7123); const b = mkInstance(path.join(root, 'b', '.hatch'), 7124);
  const base = { stampDir: stamps, ppid: process.pid, user: 'tester', port: 7123 };
  const walk = { dir: a, how: 'walk', alternatives: [] };
  let e = tty(), o = tty();
  assert.equal(instanceNotice({ ...base, resolved: walk, stderr: e, stdout: o }), true);
  assert.equal(e.out.length, 1); assert.match(e.out[0], /^hatch: using the instance at .*\.hatch \(port 7123\)\. .*--state DIR.*HATCH_STATE=DIR\.\n$/);
  assert.equal(instanceNotice({ ...base, resolved: walk, stderr: e, stdout: o }), false, 'same dir again is quiet');
  const home = { dir: b, how: 'home', alternatives: [] };
  assert.equal(instanceNotice({ ...base, resolved: home, stderr: e, stdout: o }), true, 'changed dir prints again');
  assert.equal(e.out.length, 2);
  // not surprising
  for (const how of ['flag', 'env']) { e = tty(); assert.equal(instanceNotice({ ...base, ppid: 1, resolved: { dir: a, how, alternatives: [] }, stderr: e, stdout: o }), false); assert.equal(e.out.length, 0); }
  // a conflict is surprising
  e = tty(); assert.equal(instanceNotice({ ...base, ppid: 2, resolved: { dir: a, how: 'env', alternatives: [{ dir: b, how: 'walk' }] }, stderr: e, stdout: o }), true);
  assert.match(e.out[0], /from HATCH_STATE; another one exists at/);
  // not a TTY (either stream)
  e = tty(); assert.equal(instanceNotice({ ...base, ppid: 3, resolved: walk, stderr: { ...e, isTTY: false }, stdout: o }), false);
  assert.equal(instanceNotice({ ...base, ppid: 3, resolved: walk, stderr: e, stdout: { isTTY: false } }), false);
  assert.equal(e.out.length, 0);
});

test('instance notice stamps: written per shell pid, stale ones of dead pids are removed', () => {
  const stamps = tmp(); const dead = deadPid();
  fs.writeFileSync(path.join(stamps, `hatch-notice-tester-${dead}`), 'x');
  fs.writeFileSync(path.join(stamps, `hatch-notice-someone-${dead}`), 'x');
  fs.writeFileSync(path.join(stamps, 'unrelated'), 'x');
  const root = fs.realpathSync(tmp()); const a = mkInstance(path.join(root, '.hatch'));
  instanceNotice({ resolved: { dir: a, how: 'walk', alternatives: [] }, stampDir: stamps, ppid: process.pid, user: 'tester', stderr: tty(), stdout: tty() });
  const names = fs.readdirSync(stamps).sort();
  assert.deepEqual(names, [`hatch-notice-someone-${dead}`, `hatch-notice-tester-${process.pid}`, 'unrelated']);
  assert.equal(fs.readFileSync(path.join(stamps, `hatch-notice-tester-${process.pid}`), 'utf8'), a);
});

test('the CLI stays quiet when its streams are pipes', async () => {
  const root = fs.realpathSync(tmp()); mkInstance(path.join(root, '.hatch'), 1); // port 1: nothing listens
  const r = await new Promise((resolve) => {
    const p = spawn('node', [CLI, 'panels'], { cwd: root, env: { PATH: process.env.PATH, HOME: path.join(root, 'nohome') } });
    let stderr = ''; p.stderr.on('data', (d) => { stderr += d; }); p.on('close', (status) => resolve({ status, stderr }));
  });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /using the instance/);
  assert.match(r.stderr, /cannot reach Hatch at http:\/\/127\.0\.0\.1:1 /);
  assert.match(r.stderr, /Port 1 comes from .*\.hatch\/config\.json/);
});

test('shortPath and readOwner', () => {
  assert.equal(shortPath('/h/me/p/.hatch', '/h/me'), '~/p/.hatch');
  assert.equal(shortPath('/elsewhere/.hatch', '/h/me'), '/elsewhere/.hatch');
  const d = fs.realpathSync(tmp());
  assert.equal(readOwner(d), null);
  fs.writeFileSync(path.join(d, 'server.lock'), 'garbage{'); assert.equal(readOwner(d), null);
  fs.writeFileSync(path.join(d, 'server.lock'), JSON.stringify({ pid: process.pid, port: 7000 }));
  assert.deepEqual(readOwner(d), { pid: process.pid, port: 7000, alive: true });
  fs.rmSync(path.join(d, 'server.lock')); fs.writeFileSync(path.join(d, 'hatch.pid'), String(process.pid));
  assert.equal(readOwner(d).alive, true);
});

test('unreachable errors say where the port came from and what to do', async () => {
  const root = fs.realpathSync(tmp()); const dir = mkInstance(path.join(root, '.hatch'), 1);
  const call = () => makeClient(dir)('GET', '/api/health').then(() => assert.fail('should not connect'), (e) => e);
  let e = await call();
  assert.equal(e.code, 2); assert.match(e.message, /cannot reach Hatch at http:\/\/127\.0\.0\.1:1 \(/);
  assert.match(e.message, /Port 1 comes from .*config\.json\./); assert.match(e.message, /--state DIR or set HATCH_STATE/);
  // owner alive on another port: config.json looks wrong
  fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid: process.pid, port: 7555 }));
  e = await call(); assert.match(e.message, /runs on port 7555, so config\.json looks wrong.*hatch-server restart --state /);
  // owner alive on the same port: running but silent
  fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid: process.pid, port: 1 }));
  e = await call(); assert.match(e.message, /is running but did not answer/);
  // owner gone
  fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid: deadPid(), port: 1 }));
  e = await call(); assert.match(e.message, /is not running: start it with `hatch-server serve --state /);
  // garbage record behaves like none
  fs.writeFileSync(path.join(dir, 'server.lock'), '{{');
  e = await call(); assert.match(e.message, /--state DIR or set HATCH_STATE/);
});
