import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, waitFor } from './helpers.js';

const HATCH = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));
const upgradeStatus = (port, token, pathName) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${pathName} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nx-token: ${token}\r\n\r\n`));
  let buf = ''; s.on('data', (d) => { buf += d; if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } }); s.on('close', () => resolve(buf.split('\r\n')[0] || 'closed')); setTimeout(() => { s.destroy(); resolve(buf.split('\r\n')[0] || 'timeout'); }, 2000);
});

test('view-only: a WebSocket upgrade through the proxy is refused (it used to reach local ports)', async () => {
  const local = http.createServer((req, res) => res.end('SECRET-FROM-LOCAL')); await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const full = await startHatch(); const view = await startHatch({ viewOnly: true });
  try {
    const lp = local.address().port;
    assert.match(await upgradeStatus(view.port, view.hatch.token, `/proxy/${lp}/x`), /403/, 'view-only instance, full token');
    assert.doesNotMatch(await upgradeStatus(full.port, full.hatch.token, `/proxy/${lp}/x`), /403/, 'a normal instance still tunnels');
  } finally { await full.close(); await view.close(); await new Promise((r) => local.close(r)); }
});

test('revoking the view token ends streams that were opened with it; the full token is never cut', async () => {
  const h = await startHatch();
  try {
    const vt = /\?t=(\w+)/.exec(spawnSync('node', [HATCH, 'url', '--view', '--state', h.stateDir], { encoding: 'utf8' }).stdout)[1];
    const open = async (token) => { const ctl = new AbortController(); const res = await fetch(`${h.base}/api/events`, { headers: { 'x-token': token }, signal: ctl.signal }); let ended = false; (async () => { try { for await (const _ of res.body) { void _; } } catch { /* aborted */ } ended = true; })(); return { ended: () => ended, stop: () => ctl.abort() }; };
    const v = await open(vt); const f = await open(h.hatch.token); await new Promise((r) => setTimeout(r, 300));
    spawnSync('node', [HATCH, 'url', '--revoke-view', '--state', h.stateDir]);
    await waitFor(() => v.ended(), 9000); assert.equal(f.ended(), false, 'the full-token stream stays open'); f.stop();
  } finally { await h.close(); }
});

test('client log: control characters are stripped (no forged lines or escape codes)', async () => {
  const h = await startHatch();
  try {
    await h.call('POST', '/api/clientlog', { message: 'x\n2026-01-01T00:00:00Z hatch fake line\u001b]52;c;AAAA\u0007', source: 'a\nb', line: 1, agent: 'u\r\na' });
    const text = fs.readFileSync(path.join(h.stateDir, 'log', 'server.log'), 'utf8');
    assert.doesNotMatch(text, /\u001b/); const ours = text.split('\n').filter((l) => l.includes('client error')); assert.equal(ours.length, 1, 'one log line, however many newlines were sent');
    assert.ok(!text.split('\n').some((l) => l.startsWith('2026-01-01T00:00:00Z hatch fake line')), 'no forged line');
  } finally { await h.close(); }
});

test('a browser holding the view cookie can log in with the full link (and a view link does not downgrade)', async () => {
  const h = await startHatch();
  try {
    const vt = /\?t=(\w+)/.exec(spawnSync('node', [HATCH, 'url', '--view', '--state', h.stateDir], { encoding: 'utf8' }).stdout)[1];
    const up = await fetch(`${h.base}/?t=${h.hatch.token}`, { redirect: 'manual', headers: { cookie: `hatch_token=${vt}` } });
    assert.equal(up.status, 302); assert.match(up.headers.get('set-cookie'), /hatch_session=[a-f0-9]{64}/); assert.doesNotMatch(up.headers.get('set-cookie'), new RegExp(`hatch_session=${h.hatch.token}`), 'the cookie holds a session id, not the token');
    const down = await fetch(`${h.base}/?t=${vt}`, { redirect: 'manual', headers: { cookie: `hatch_token=${h.hatch.token}` } });
    assert.equal(down.status, 200, 'a full session is not replaced by a view link');
  } finally { await h.close(); }
});

