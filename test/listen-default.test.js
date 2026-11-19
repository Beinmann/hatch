import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';
import { linkHost, isLoopbackHost } from '../src/find.js';

const SERVER = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));

// Starts `serve`, waits for the "Listening on" line, stops it and returns the output.
function serve(state, args = []) {
  const env = { ...process.env, HOME: tmp() }; for (const k of Object.keys(env)) if (k.startsWith('HATCH_')) delete env[k];
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER, 'serve', '--state', state, '--yes', '--port', '0', '--session', `hl-${process.pid}-${Math.random().toString(36).slice(2, 7)}`, ...args], { env });
    let out = ''; let err = ''; let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); p.kill('SIGTERM'); p.on('close', () => resolve({ out, err })); } };
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`no start line: ${out} ${err}`)); }, 10000);
    p.stdout.on('data', (d) => { out += d; if (/Listening on/.test(out)) finish(); });
    p.stderr.on('data', (d) => { err += d; });
  });
}
const savedHost = (state) => JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8')).host;

test('serve with no --host and no saved host listens on 127.0.0.1 only and says so', async () => {
  const state = path.join(tmp(), 's');
  const r = await serve(state);
  assert.match(r.out, /Listening on 127\.0\.0\.1 only/); assert.doesNotMatch(r.out, /anyone on this network/);
  assert.equal(savedHost(state), '127.0.0.1');
});

test('--host 0.0.0.0 still works, keeps the network warning and is remembered; a later plain serve keeps it', async () => {
  const state = path.join(tmp(), 's');
  const r = await serve(state, ['--host', '0.0.0.0']);
  assert.match(r.out, /all interfaces.*anyone on this network/); assert.equal(savedHost(state), '0.0.0.0');
  const again = await serve(state);
  assert.match(again.out, /all interfaces/); assert.equal(savedHost(state), '0.0.0.0');
});

test('an instance with a host already saved keeps it on upgrade; --host overrides it', async () => {
  const state = path.join(tmp(), 's');
  await serve(state);
  const file = path.join(state, 'config.json'); const cfg = JSON.parse(fs.readFileSync(file, 'utf8')); cfg.host = '0.0.0.0'; fs.writeFileSync(file, JSON.stringify(cfg));
  assert.match((await serve(state)).out, /all interfaces/);
  assert.match((await serve(state, ['--host', '127.0.0.1'])).out, /Listening on 127\.0\.0\.1 only/); assert.equal(savedHost(state), '127.0.0.1');
});

test('links show 127.0.0.1 for a loopback host and the LAN address for "all interfaces"', () => {
  assert.equal(linkHost('127.0.0.1'), '127.0.0.1'); assert.equal(linkHost('localhost'), '127.0.0.1');
  assert.equal(linkHost('100.64.0.7'), '100.64.0.7'); assert.equal(linkHost('0.0.0.0'), linkHost(undefined));
  assert.ok(isLoopbackHost('127.0.0.1')); assert.ok(!isLoopbackHost('0.0.0.0'));
});
