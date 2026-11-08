import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readAllowedHostsFile } from '../src/hosts.js';
import { createHatch } from '../src/server.js';
import { tmp } from './helpers.js';

const get = (port, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});
const start = async (stateDir) => {
  const hatch = createHatch({ stateDir, host: '127.0.0.1', port: 0, attach: ['cat'], cwd: path.dirname(stateDir), findBin: () => null });
  return { hatch, port: await hatch.listen() };
};

test('allowed-hosts file: comments, blanks, wildcards; missing file is fine; unreadable warns', () => {
  const dir = tmp();
  try {
    assert.deepEqual(readAllowedHostsFile(dir), []);
    fs.writeFileSync(path.join(dir, 'allowed-hosts'), '# mine\nBox.Example.test\n\n*.lan.test  # wildcard\n');
    assert.deepEqual(readAllowedHostsFile(dir), ['box.example.test', '*.lan.test']);
    const dir2 = tmp(); const warnings = [];
    fs.mkdirSync(path.join(dir2, 'allowed-hosts'));
    assert.deepEqual(readAllowedHostsFile(dir2, (m) => warnings.push(m)), []);
    assert.equal(warnings.length, 1); fs.rmSync(dir2, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a host in .hatch/allowed-hosts is accepted after a fresh start; refusals name the host and the file', async () => {
  const dir = tmp(); const stateDir = path.join(dir, '.hatch');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'allowed-hosts'), 'files.example.test\n');
  const { hatch, port } = await start(stateDir);
  try {
    assert.notEqual((await get(port, `files.example.test:${port}`)).status, 403);
    const refused = await get(port, `other.example.test:${port}`);
    assert.equal(refused.status, 403);
    assert.match(refused.body, /other\.example\.test/); assert.match(refused.body, /allowed-hosts/);
    assert.ok(!('allowedHosts' in JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'))), 'file hosts are not copied into config.json');
  } finally { await hatch.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable allowed-hosts file does not stop the server', async () => {
  const dir = tmp(); const stateDir = path.join(dir, '.hatch');
  fs.mkdirSync(path.join(stateDir, 'allowed-hosts'), { recursive: true });
  const { hatch, port } = await start(stateDir);
  try { assert.equal((await get(port, `x.example.test:${port}`)).status, 403); assert.notEqual((await get(port, `127.0.0.1:${port}`)).status, 403); }
  finally { await hatch.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
