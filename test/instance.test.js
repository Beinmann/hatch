import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, findStateDir, chooseStateDir, defaultStateDir, makeClient } from '../src/find.js';
import { shortPath, readOwner } from '../src/instance.js';
import { tmp } from './helpers.js';

const CLI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const mkInstance = (dir, port = 7099) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, token: 'tok' })); return fs.realpathSync(dir); };
const tty = () => { const out = []; return { isTTY: true, write: (s) => out.push(s), out }; };
const deadPid = () => { let p = 4000000; while (true) { try { process.kill(p, 0); p++; } catch { return p; } } };

test('state dir order: --state, then HATCH_STATE, then ~/.hatch; the cwd is never consulted', () => {
  const root = fs.realpathSync(tmp());
  const proj = path.join(root, 'proj'); const sub = path.join(proj, 'a', 'b'); fs.mkdirSync(sub, { recursive: true });
  mkInstance(path.join(proj, '.hatch')); // a project-local instance: must be ignored
  const other = mkInstance(path.join(root, 'other')); const envDir = mkInstance(path.join(root, 'envdir'));
  const homeDir = path.join(root, 'home'); const home = mkInstance(path.join(homeDir, '.hatch'));
  const env = { HOME: homeDir };
  assert.deepEqual(resolveStateDir({ state: other, env: { ...env, HATCH_STATE: envDir }, cwd: sub }), { dir: other, how: 'flag', explicit: true });
  assert.deepEqual(resolveStateDir({ env: { ...env, HATCH_STATE: envDir }, cwd: sub }), { dir: envDir, how: 'env', explicit: true });
  assert.deepEqual(resolveStateDir({ env, cwd: sub }), { dir: home, how: 'default', explicit: false }, 'the .hatch of the cwd chain is not used');
  assert.equal(findStateDir({ env, cwd: sub }), home);
  assert.equal(defaultStateDir(env), path.join(homeDir, '.hatch'));
  assert.equal(chooseStateDir({ env: { HOME: homeDir, HATCH_STATE: '' }, cwd: sub }).how, 'default', 'an empty HATCH_STATE counts as unset');
  assert.equal(chooseStateDir({ state: 'rel', env, cwd: sub }).dir, path.join(sub, 'rel'));
});

test('no walk-up: without ~/.hatch the CLI errors even with a project .hatch above, and the message says how to start and migrate', () => {
  const root = fs.realpathSync(tmp()); const sub = path.join(root, 'p', 'x'); fs.mkdirSync(sub, { recursive: true });
  mkInstance(path.join(root, 'p', '.hatch'));
  assert.throws(() => resolveStateDir({ env: { HOME: path.join(root, 'nohome') }, cwd: sub }), /no Hatch instance found.*hatch-server start.*hatch migrate/s);
  assert.throws(() => resolveStateDir({ state: path.join(root, 'x'), env: {} }), /--state state dir.*hatch-server serve --state/s);
  assert.throws(() => resolveStateDir({ env: { HATCH_STATE: path.join(root, 'x'), HOME: root } }), /HATCH_STATE/);
});

test('the CLI reports an unreachable default instance without extra notices', async () => {
  const root = fs.realpathSync(tmp()); mkInstance(path.join(root, '.hatch'), 1); // port 1: nothing listens; HOME=root makes it the default instance
  const r = await new Promise((resolve) => {
    const p = spawn('node', [CLI, 'panels'], { cwd: root, env: { PATH: process.env.PATH, HOME: root } });
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
  e = await call(); assert.match(e.message, /is not running: start it with `hatch-server start --state /);
  // garbage record behaves like none
  fs.writeFileSync(path.join(dir, 'server.lock'), '{{');
  e = await call(); assert.match(e.message, /--state DIR or set HATCH_STATE/);
});
