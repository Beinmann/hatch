import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/state.js';
import { readConfig, makeClient } from '../src/find.js';
import { startHatch, tmp } from './helpers.js';

const backups = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('config.invalid-'));

test('startup recovers malformed configuration with an exact private backup and stable regenerated settings', () => {
  for (const original of ['{broken', 'null', '[]', '42', '"text"', 'false']) {
    const dir = tmp(); const warnings = [];
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), original);
      const cfg = loadConfig(dir, {}, { warn: (message) => warnings.push(message) });
      assert.match(cfg.token, /^[a-f0-9]{32}$/); assert.match(cfg.session, /^hatch-/);
      const files = backups(dir); assert.equal(files.length, 1);
      assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), original);
      assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
      assert.equal(warnings.length, 1); assert.ok(warnings[0].includes(files[0]));
      assert.equal(loadConfig(dir).token, cfg.token); assert.equal(loadConfig(dir).session, cfg.session);
      assert.equal(backups(dir).length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('configuration repair retains valid unrelated settings and safe host entries', () => {
  const dir = tmp(); const file = path.join(dir, 'config.json');
  try {
    const original = JSON.stringify({ token: 'short', session: { bad: true }, allowedHosts: ['example.test', null], customSetting: { keep: true } });
    fs.writeFileSync(file, original); const warnings = [];
    const cfg = loadConfig(dir, {}, { warn: (message) => warnings.push(message) });
    assert.deepEqual(cfg.customSetting, { keep: true }); assert.deepEqual(cfg.allowedHosts, ['example.test']);
    assert.match(cfg.session, /^hatch-/); assert.match(cfg.token, /^[a-f0-9]{32}$/);
    assert.match(warnings[0], /invalid token.*invalid tmux session.*allowedHosts/);
    assert.equal(fs.readFileSync(path.join(dir, backups(dir)[0]), 'utf8'), original);
    const stable = { token: 'valid-token-123456', session: 'existing-session', allowedHosts: ['example.test'] };
    fs.writeFileSync(file, JSON.stringify(stable)); assert.deepEqual(loadConfig(dir), stable);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed configuration backup leaves the original configuration intact', (t) => {
  const dir = tmp(); const file = path.join(dir, 'config.json'); const original = '{broken';
  try {
    fs.writeFileSync(file, original); const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.basename(to).startsWith('config.invalid-')) throw Object.assign(new Error('backup failed'), { code: 'EACCES' });
      return rename(from, to);
    });
    assert.throws(() => loadConfig(dir), /backup failed/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(backups(dir), []); assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith('.tmp')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('client configuration errors are actionable, use exit code 2 and leave the file untouched', () => {
  const dir = tmp(); const file = path.join(dir, 'config.json');
  try {
    for (const original of ['{broken', 'null', '[]', '{}', '{"port":"7070","token":"token"}', '{"port":70000,"token":"token"}', '{"port":7070,"token":null}', '{"port":7070,"token":"line\\nbreak"}', '{"port":7070,"token":"null\\u0000byte"}']) {
      fs.writeFileSync(file, original);
      for (const read of [readConfig, makeClient]) assert.throws(() => read(dir), e => e.code === 2 && /repair the file/.test(e.message));
      assert.equal(fs.readFileSync(file, 'utf8'), original); assert.deepEqual(backups(dir), []);
    }
    fs.writeFileSync(file, '{"port":7070,"token":"valid-token"}'); assert.equal(readConfig(dir).port, 7070);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server recovers invalid configuration and exposes its recovery warning', async () => {
  const project = tmp(); const stateDir = path.join(project, '.hatch'); fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'config.json'), 'null');
  const h = await startHatch({ stateDir });
  try {
    assert.equal((await h.call('GET', '/api/health')).status, 200);
    const warning = h.hatch.state.snapshot().warnings.find((entry) => entry.file === 'config.json');
    assert.match(warning.message, /Original saved in config.invalid-/);
    assert.match(fs.readFileSync(path.join(stateDir, 'log', 'server.log'), 'utf8'), /Recovered/);
    assert.equal(fs.readFileSync(path.join(stateDir, backups(stateDir)[0]), 'utf8'), 'null');
    assert.equal(readConfig(stateDir).port, h.port);
  } finally { await h.close(); fs.rmSync(project, { recursive: true, force: true }); }
});
