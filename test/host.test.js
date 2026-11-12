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
