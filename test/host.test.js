import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHatch, tmp } from './helpers.js';
import { resolvePageFile } from '../src/pages.js';

function site() {
  const d = tmp(); const site = path.join(d, 'site'); fs.mkdirSync(path.join(site, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(site, 'page.html'), '<!doctype html><link rel=stylesheet href=style.css><h1>hi</h1>');
  fs.writeFileSync(path.join(site, 'style.css'), 'h1{color:red}');
  fs.writeFileSync(path.join(site, 'sub', 'a.txt'), 'inner');
  fs.writeFileSync(path.join(site, '.secret'), 'nope');
  fs.writeFileSync(path.join(d, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(d, 'outside.txt'), path.join(site, 'leak.txt'));
  fs.symlinkSync(d, path.join(site, 'up'));
  fs.symlinkSync(path.join(site, 'style.css'), path.join(site, 'alias.css'));
  return { d, site };
}
const get = (base, route, headers = {}) => fetch(base + route, { headers, redirect: 'manual' });

test('the shared path resolver resolves only regular files inside the folder', () => {
  const { site: s } = site(); const root = s;
  assert.ok(resolvePageFile(root, 'page.html'));
  assert.ok(resolvePageFile(root, 'sub/a.txt'));
  assert.ok(resolvePageFile(root, 'alias.css'), 'a link that stays inside is fine');
  for (const bad of ['../outside.txt', 'sub/../../outside.txt', 'leak.txt', 'up/outside.txt', '.secret', 'sub', '', 'missing.txt', '%2e%2e/x']) assert.equal(resolvePageFile(root, bad), null, bad);
});

test('hatch host: POST /api/host, then the page and its assets are served; nothing else', async () => {
  const { site: s } = site(); const h = await startHatch();
  try {
    const r = await h.call('POST', '/api/host', { file: path.join(s, 'page.html') });
    assert.equal(r.status, 200); assert.match(r.data.path, /^\/host\/[0-9a-f]{10}\/page\.html$/);
    assert.equal((await h.call('POST', '/api/host', { file: path.join(s, 'page.html') })).data.path, r.data.path, 'same file, same URL');
    const base = r.data.path.replace(/page\.html$/, ''); const tok = { 'x-token': h.hatch.token };
    const page = await get(h.base, r.data.path, tok); assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/); assert.match(await page.text(), /<h1>hi/);
    assert.equal((await get(h.base, base, tok)).status, 200, 'the folder URL shows the entry file');
    assert.equal(await (await get(h.base, `${base}style.css`, tok)).text(), 'h1{color:red}');
    assert.equal(await (await get(h.base, `${base}sub/a.txt`, tok)).text(), 'inner');
    for (const bad of ['..%2foutside.txt', '../outside.txt', 'leak.txt', 'up/outside.txt', '.secret', 'sub', '%2e%2e/outside.txt', '..%5coutside.txt']) assert.equal((await get(h.base, base + bad, tok)).status, 404, bad);
    assert.equal((await get(h.base, '/host/ffffffffff/page.html', tok)).status, 404, 'unknown id');
    assert.equal((await fetch(h.base + r.data.path, { method: 'POST', headers: tok })).status, 405);
  } finally { await h.close(); }
});

test('hosted pages need the token; the ?t= link logs in; a view token may read but not host', async () => {
  const { site: s } = site(); const h = await startHatch();
  try {
    const r = await h.call('POST', '/api/host', { file: path.join(s, 'page.html') });
    assert.equal((await get(h.base, r.data.path)).status, 401);
    assert.equal((await get(h.base, r.data.path, { 'x-token': 'wrong-token-value-1234' })).status, 401);
    const login = await get(h.base, `${r.data.path}?t=${h.hatch.token}`); assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await get(h.base, r.data.path, { cookie })).status, 200, 'cookie from the link opens the page and its assets');
    const view = 'v'.repeat(32); const cfgFile = path.join(h.stateDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), viewToken: view }));
    assert.equal((await get(h.base, r.data.path, { 'x-token': view })).status, 200);
    const post = await fetch(`${h.base}/api/host`, { method: 'POST', headers: { 'x-token': view, 'content-type': 'application/json' }, body: JSON.stringify({ file: path.join(s, 'page.html') }) });
    assert.equal(post.status, 403);
  } finally { await h.close(); }
});

test('POST /api/host validates the file', async () => {
  const { site: s } = site(); const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/host', { file: 'page.html' })).status, 400);
    assert.equal((await h.call('POST', '/api/host', { file: path.join(s, 'nope.html') })).status, 404);
    assert.equal((await h.call('POST', '/api/host', { file: s })).status, 400);
    assert.equal((await h.call('POST', '/api/host', { file: path.join(s, '.secret') })).status, 400);
  } finally { await h.close(); }
});

test('hatch host CLI: refuses without a terminal or --yes, registers nothing; --yes works', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const BIN = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const home = tmp();
  const run = (state, args) => new Promise((resolve) => {
    const p = spawn('node', [BIN, '--state', state, ...args], { env: { ...process.env, HOME: home, HATCH_STATE: '', HATCH_URL: '', HATCH_WORKSPACE: '' } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr })); p.stdin.end('y\n');
  });
  const h = await startHatch();
  try {
    const { site: s } = site(); const page = path.join(s, 'page.html');
    let r = await run(h.stateDir, ['host', page]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /not sandboxed/); assert.match(r.stderr, /--yes/); assert.equal(r.stdout, '');
    r = await run(h.stateDir, ['host', page, '--yes']);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /not sandboxed/); assert.match(r.stdout, /\/host\//);
  } finally { await h.close(); }
});

test('hosted pages can be listed and stopped (full token only)', async () => {
  const { site: s } = site(); const h = await startHatch();
  try {
    assert.deepEqual((await h.call('GET', '/api/host')).data, []);
    const a = (await h.call('POST', '/api/host', { file: path.join(s, 'page.html') })).data;
    const b = (await h.call('POST', '/api/host', { file: path.join(s, 'style.css') })).data;
    const l = (await h.call('GET', '/api/host')).data;
    assert.deepEqual(l.map((x) => x.id).sort(), [a.id, b.id].sort());
    const first = l.find((x) => x.id === a.id);
    assert.equal(first.entry, 'page.html'); assert.equal(first.path, a.path); assert.equal(first.dir, fs.realpathSync(s));
    const tok = { 'x-token': h.hatch.token };
    // a view token can neither list nor stop
    const view = 'v'.repeat(32); const cfgFile = path.join(h.stateDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), viewToken: view }));
    for (const [m, route] of [['GET', '/api/host'], ['DELETE', `/api/host/${a.id}`], ['DELETE', '/api/host']]) assert.equal((await fetch(h.base + route, { method: m, headers: { 'x-token': view } })).status, 403, `${m} ${route}`);
    assert.equal((await get(h.base, a.path, tok)).status, 200, 'refused requests stopped nothing');
    // stop one
    assert.equal((await h.call('DELETE', `/api/host/${a.id}`)).status, 200);
    assert.equal((await get(h.base, a.path, tok)).status, 404);
    assert.equal((await get(h.base, b.path, tok)).status, 200, 'the other page is still hosted');
    const gone = await h.call('DELETE', `/api/host/${a.id}`); assert.equal(gone.status, 404); assert.match(gone.data.error, /not hosted/);
    assert.equal((await h.call('DELETE', '/api/host/ffffffffff')).status, 404);
    // stop all
    const all = await h.call('DELETE', '/api/host'); assert.equal(all.status, 200); assert.equal(all.data.stopped, 1);
    assert.equal((await get(h.base, b.path, tok)).status, 404);
    assert.deepEqual((await h.call('GET', '/api/host')).data, []);
  } finally { await h.close(); }
});

test('hatch host list / stop CLI; a file named list needs ./list', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const BIN = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const home = tmp();
  const run = (state, args, cwd) => new Promise((resolve) => {
    const p = spawn('node', [BIN, '--state', state, ...args], { cwd, env: { ...process.env, HOME: home, HATCH_STATE: '', HATCH_URL: '', HATCH_WORKSPACE: '' } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr })); p.stdin.end();
  });
  const h = await startHatch();
  try {
    const { site: s } = site(); fs.writeFileSync(path.join(s, 'list'), 'plain');
    let r = await run(h.stateDir, ['host', 'list']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /nothing hosted/);
    r = await run(h.stateDir, ['host', 'list', '--json']); assert.deepEqual(JSON.parse(r.stdout), []);
    assert.equal((await run(h.stateDir, ['host', path.join(s, 'page.html'), '--yes'])).status, 0);
    assert.equal((await run(h.stateDir, ['host', './list', '--yes'], s)).status, 0, 'a file named list is hosted as ./list');
    r = await run(h.stateDir, ['host', 'list']); assert.match(r.stdout, /ID\s+FILE\s+FOLDER\s+LINK PATH/); assert.match(r.stdout, /page\.html/); assert.match(r.stdout, /\/host\/[0-9a-f]{10}\/list/);
    const id = JSON.parse((await run(h.stateDir, ['host', 'list', '--json'])).stdout).find((x) => x.entry === 'page.html').id;
    r = await run(h.stateDir, ['host', 'stop', id]); assert.equal(r.status, 0, r.stderr);
    r = await run(h.stateDir, ['host', 'stop', id]); assert.notEqual(r.status, 0); assert.match(r.stderr, /not hosted/);
    assert.notEqual((await run(h.stateDir, ['host', 'stop'])).status, 0);
    r = await run(h.stateDir, ['host', 'stop', '--all']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /stopped hosting 1 page\b/);
    assert.match((await run(h.stateDir, ['host', 'list'])).stdout, /nothing hosted/);
  } finally { await h.close(); }
});

test('POST /api/host sends open-hosted to full clients only, honours ws and open:false', async () => {
  const { readSse } = await import('./helpers.js');
  const { site: s } = site(); const h = await startHatch();
  try {
    const view = 'v'.repeat(32); const cfgFile = path.join(h.stateDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), viewToken: view }));
    const none = (e) => e.some((x) => x.event === 'open-hosted');
    const full = readSse(`${h.base}/api/events?cid=f1`, { 'x-token': h.hatch.token }, none, 1500);
    const watch = readSse(`${h.base}/api/events?cid=v1`, { 'x-token': view }, none, 1500);
    await new Promise((r) => setTimeout(r, 300));
    const file = path.join(s, 'page.html');
    assert.equal((await h.call('POST', '/api/host', { file, open: false })).data.opened, 0);
    assert.equal((await h.call('POST', '/api/host', { file, ws: 'elsewhere' })).data.opened, 0, 'no tab shows that workspace');
    const r = await h.call('POST', '/api/host', { file }); assert.equal(r.data.opened, 1, 'the view-only stream is not counted');
    const got = (await full).filter((x) => x.event === 'open-hosted').map((x) => JSON.parse(x.data));
    assert.equal(got.length, 1); assert.equal(got[0].path, r.data.path); assert.match(got[0].id, /^[0-9a-f]{12}$/);
    assert.equal((await watch).filter((x) => x.event === 'open-hosted').length, 0);
  } finally { await h.close(); }
});
