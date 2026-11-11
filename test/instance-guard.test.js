import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, tmp } from './helpers.js';
import { livePidFileOwner } from '../src/instance-guard.js';

const SERVER = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));
// A second `serve` with the real state of nobody: HATCH_STATE/HATCH_URL are scrubbed so it can only touch the dir given.
const serve = (args, ms = 8000) => new Promise((resolve) => {
  const env = { ...process.env }; for (const k of ['HATCH_STATE', 'HATCH_URL', 'HATCH_PLAN']) delete env[k];
  const p = spawn('node', [SERVER, 'serve', '--host', '127.0.0.1', '--yes', ...args], { env });
  let out = ''; let err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => p.kill('SIGKILL'), ms);
  p.on('close', (status) => { clearTimeout(timer); resolve({ status, out, err }); });
});

test('serve refuses a state dir owned by a live server (answering port) and leaves config.json untouched', async () => {
  const h = await startHatch();
  try {
    const file = path.join(h.stateDir, 'config.json'); const before = fs.readFileSync(file, 'utf8');
    const r = await serve(['--state', h.stateDir]);
    assert.equal(r.status, 1, r.out); assert.match(r.err, new RegExp(`port ${h.port}`)); assert.match(r.err, /--state DIR --port N/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'config.json unchanged');
    assert.equal(fs.existsSync(path.join(h.stateDir, 'hatch.pid')), false, 'no pid file written');
    const r2 = await serve(['--state', h.stateDir, '--port', '0']); assert.equal(r2.status, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { await h.close(); }
});

test('serve refuses when hatch.pid names a live process that is a Hatch server; the message names the pid', async () => {
  const dir = tmp(); const state = path.join(dir, '.hatch'); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ port: 7999, token: 'x'.repeat(32) }));
  const before = fs.readFileSync(path.join(state, 'config.json'), 'utf8');
  // a stand-in whose command line contains hatch-server, so the /proc check accepts it
  const fake = spawn('node', ['-e', 'setTimeout(()=>{},20000)', 'hatch-server']);
  try {
    fs.writeFileSync(path.join(state, 'hatch.pid'), `${fake.pid}\n`);
    const r = await serve(['--state', state]);
    assert.equal(r.status, 1); assert.match(r.err, new RegExp(`pid ${fake.pid}`)); assert.match(r.err, /port 7999/);
    assert.equal(fs.readFileSync(path.join(state, 'config.json'), 'utf8'), before);
  } finally { fake.kill('SIGKILL'); }
});

test('a stale pid file (process gone) or a live pid that is not a Hatch server does not block', async () => {
  const dir = tmp(); const state = path.join(dir, '.hatch'); fs.mkdirSync(state);
  const gone = spawn('node', ['-e', '0']); await new Promise((r) => gone.on('close', r));
  fs.writeFileSync(path.join(state, 'hatch.pid'), `${gone.pid}\n`); assert.equal(livePidFileOwner(state), null);
  fs.writeFileSync(path.join(state, 'hatch.pid'), `${process.ppid}\n`); // alive, but not named hatch-server (on Linux)
  if (fs.existsSync('/proc/self/cmdline')) assert.equal(livePidFileOwner(state), null);
  fs.writeFileSync(path.join(state, 'hatch.pid'), 'junk\n'); assert.equal(livePidFileOwner(state), null);
  fs.writeFileSync(path.join(state, 'hatch.pid'), `${process.pid}\n`); assert.equal(livePidFileOwner(state), null, 'our own pid is never an owner');
});

test('serve on a free state dir still starts and writes config.json with the port it listens on', async () => {
  const dir = tmp(); const state = path.join(dir, '.hatch');
  const env = { ...process.env }; for (const k of ['HATCH_STATE', 'HATCH_URL', 'HATCH_PLAN']) delete env[k];
  const p = spawn('node', [SERVER, 'serve', '--host', '127.0.0.1', '--yes', '--state', state, '--port', '0'], { env, cwd: dir });
  try {
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('no start')), 8000); p.stdout.on('data', (d) => { if (/is running/.test(String(d))) { clearTimeout(t); resolve(); } }); });
    assert.ok(JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8')).port > 0);
  } finally { p.kill('SIGTERM'); }
});
