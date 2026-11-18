import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startHatch } from './helpers.js';
import { tokenAge, readTokenAge, touchTokenStamp } from '../src/token.js';

const HATCH_SERVER = new URL('../bin/hatch-server.js', import.meta.url).pathname;
const cli = (args, home) => new Promise((resolve) => execFile('node', [HATCH_SERVER, ...args], { env: { ...process.env, HOME: home, HATCH_STATE: '', HATCH_URL: '' } }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
const DAY = 86400000;

test('tokenAge: unknown without a stamp, stale only after 30 full days', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  for (const bad of [null, undefined, '', 'garbage']) assert.deepEqual(tokenAge(bad, now), { changedAt: null, ageDays: null, stale: false });
  const at = (days) => tokenAge(new Date(now - days * DAY).toISOString(), now);
  assert.equal(at(0).ageDays, 0); assert.equal(at(30).stale, false); assert.equal(at(31).stale, true); assert.equal(at(31).ageDays, 31);
  assert.equal(tokenAge(new Date(now + DAY).toISOString(), now).ageDays, 0, 'a stamp in the future counts as fresh');
});

test('the stamp is written by touch, never holds the token, and a fresh state has one', async () => {
  const h = await startHatch();
  try {
    assert.equal(readTokenAge(h.stateDir).stale, false); assert.notEqual(readTokenAge(h.stateDir).changedAt, null, 'first start stamps the new token');
    const old = new Date(Date.now() - 40 * DAY); touchTokenStamp(h.stateDir, old.getTime());
    const r = await h.call('GET', '/api/info');
    assert.equal(r.data.token.stale, true); assert.equal(r.data.token.ageDays, 40);
    assert.deepEqual(Object.keys(r.data.token).sort(), ['ageDays', 'changedAt', 'stale']);
    assert.ok(!JSON.stringify(r.data).includes(h.hatch.token), 'info never carries the token');
    assert.ok(!fs.readFileSync(path.join(h.stateDir, 'token-changed'), 'utf8').includes(h.hatch.token));
    await h.call('POST', '/api/auth/rotate-token');
    assert.equal((await h.call('GET', '/api/info')).data.token.stale, false, 'rotating resets the age');
    fs.rmSync(path.join(h.stateDir, 'token-changed'));
    assert.equal((await h.call('GET', '/api/info')).data.token.changedAt, null, 'no stamp: unknown');
  } finally { await h.close(); }
});

test('hatch-server token touch records the time and leaves the token alone', async () => {
  const h = await startHatch(); const home = path.dirname(h.stateDir);
  try {
    fs.writeFileSync(path.join(h.stateDir, 'token-changed'), new Date(Date.now() - 90 * DAY).toISOString());
    assert.equal((await h.call('GET', '/api/info')).data.token.stale, true);
    const r = await cli(['token', 'touch', '--state', h.stateDir], home);
    assert.equal(r.status, 0); assert.match(r.stdout, /token change recorded/); assert.ok(!r.stdout.includes(h.hatch.token));
    assert.equal((await h.call('GET', '/api/info')).data.token.stale, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'config.json'), 'utf8')).token, h.hatch.token);
    assert.equal((await cli(['token', '--state', h.stateDir], home)).stdout.trim(), h.hatch.token, 'plain `token` still prints it');
  } finally { await h.close(); }
});
