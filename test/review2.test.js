import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { status, stage, unstage } from '../src/git.js';
import { ports } from '../src/discover.js';
import { tmp, startHatch } from './helpers.js';

const g = (d, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });

test('mcp: a bare null line does not kill the server; it exits when stdin closes', async () => {
  const MCP = fileURLToPath(new URL('../bin/mcp.js', import.meta.url)); const h = await startHatch();
  const p = spawn('node', [MCP], { env: { ...process.env, HATCH_STATE: h.stateDir } });
  try {
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.stdin.write('null\n'); p.stdin.write('[]\n'); p.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await new Promise((r) => setTimeout(r, 600)); assert.match(out, /"id":1,"result":\{\}/); assert.equal(p.exitCode, null, 'still running');
    p.stdin.end(); await new Promise((r) => p.on('close', r)); assert.equal(p.exitCode, 0);
  } finally { p.kill(); await h.close(); }
});

test('git: unicode and glob-like names, subdirectory dirs, and unstaging work', async () => {
  const d = tmp(); g(d, 'init', '-q', '-b', 'main'); fs.mkdirSync(path.join(d, 'sub'));
  for (const n of ['café.txt', '[a].txt', 'tab\there.txt', 'sub/x.txt', 'we"ird.txt']) fs.writeFileSync(path.join(d, n), '1');
  const names = (await status(d)).files.map((f) => f.path).sort(); assert.deepEqual(names, ['[a].txt', 'café.txt', 'sub/', 'tab\there.txt', 'we"ird.txt'].sort());
  const s = await stage(path.join(d, 'sub'), ['café.txt', '[a].txt', 'sub/', 'tab\there.txt', 'we"ird.txt']); // dir is a subdirectory: paths are still root-relative
  assert.equal(s.files.every((f) => f.staged), true); assert.equal(s.root, fs.realpathSync(d));
  assert.equal((await unstage(d, ['[a].txt'])).files.find((f) => f.path === '[a].txt').staged, false, 'a glob-like name is matched literally');
  fs.writeFileSync(path.join(d, 'a -> b.txt'), '1'); assert.ok((await status(d)).files.some((f) => f.path === 'a -> b.txt'));
});

test('ports: ::1 listeners are localhost only', () => {
  const root = tmp(); fs.mkdirSync(path.join(root, 'net'));
  fs.writeFileSync(path.join(root, 'net/tcp6'), 'hdr\n   0: 00000000000000000000000001000000:1771 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n');
  assert.equal(ports(root)[0].scope, 'localhost only');
});

test('ui: diff/log are raw git args only when they are the command', async () => {
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const run = (args) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args]); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('close', (c) => res({ c, out })); });
  try {
    assert.equal((await run(['notify', 'log', '--level', 'warn'])).c, 0);
    const got = []; const { readSse } = await import('./helpers.js');
    const ev = readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'notify'), 4000); await new Promise((r) => setTimeout(r, 200));
    await run(['notify', 'diff', '--level', 'warn']); void got;
    assert.match((await ev).find((x) => x.event === 'notify').data, /"level":"warn"/);
  } finally { await h.close(); }
});
