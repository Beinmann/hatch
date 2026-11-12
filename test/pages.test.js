import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHatch, tmp } from './helpers.js';
import { openTypeFor, resolvePageFile, isPageFile } from '../src/pages.js';

test('hatch open picks the page window for .html and .htm only', () => {
  assert.equal(openTypeFor('/x/a.html', false), 'page');
  assert.equal(openTypeFor('/x/A.HTM', false), 'page');
  assert.equal(openTypeFor('/x/a.html.txt', false), 'editor');
  assert.equal(openTypeFor('/x/a.md', false), 'editor');
  assert.equal(openTypeFor('/x/a.png', false), 'image');
  assert.equal(openTypeFor('/x/a.html', true), 'files');
  assert.equal(isPageFile('page.xhtml'), false);
});

function site() {
  const root = tmp(); const dir = path.join(root, 'site'); fs.mkdirSync(path.join(dir, 'css'), { recursive: true }); fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>'); fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'secret'); fs.writeFileSync(path.join(dir, '.env'), 'secret');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside'); fs.mkdirSync(path.join(root, 'otherdir')); fs.writeFileSync(path.join(root, 'otherdir', 'x.txt'), 'x');
  fs.symlinkSync(path.join(root, 'outside.txt'), path.join(dir, 'link-out.txt'));
  fs.symlinkSync(path.join(root, 'otherdir'), path.join(dir, 'link-dir'));
  fs.symlinkSync(path.join(dir, 'css', 'a.css'), path.join(dir, 'link-in.css'));
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'link-hidden.txt'));
  return { root, dir };
}

test('resolvePageFile serves files inside the folder and refuses everything else', () => {
  const { dir } = site();
  assert.equal(resolvePageFile(dir, 'index.html'), fs.realpathSync(path.join(dir, 'index.html')));
  assert.ok(resolvePageFile(dir, 'css/a.css'));
  assert.ok(resolvePageFile(dir, 'link-in.css'), 'a symlink that stays inside is fine');
  for (const rel of ['../outside.txt', 'css/../../outside.txt', '..', '/etc/passwd', 'link-out.txt', 'link-dir/x.txt', 'link-hidden.txt', '.env', '.git/config', 'css', '', 'nope.html', 'a\0b']) {
    assert.equal(resolvePageFile(dir, rel), null, rel);
  }
});

test('page windows: key is made by the server, files need no token, everything else is refused', async () => {
  const { dir } = site(); const h = await startHatch();
  try {
    const open = await h.call('POST', '/api/panels', { type: 'page', props: { path: path.join(dir, 'index.html'), key: 'a'.repeat(32) } });
    assert.equal(open.status, 201);
    const key = open.data.props.key; assert.match(key, /^[a-f0-9]{32}$/); assert.notEqual(key, 'a'.repeat(32), 'a caller cannot choose the key');
    const get = (rel, init) => fetch(`${h.base}/page/${rel}`, init); // no token header on purpose
    const ok = await get(`${key}/index.html`);
    assert.equal(ok.status, 200); assert.equal(await ok.text(), '<h1>hi</h1>');
    assert.match(ok.headers.get('content-security-policy'), /^sandbox allow-scripts /);
    assert.doesNotMatch(ok.headers.get('content-security-policy'), /allow-same-origin/);
    assert.equal((await get(`${key}/css/a.css`)).status, 200);
    assert.equal((await get(`${key}/`)).status, 200, 'the folder URL gives the page itself');
    // wrong or malformed ids
    for (const bad of ['b'.repeat(32), 'short', key.toUpperCase(), `${key.slice(0, 31)}x`]) assert.equal((await get(`${bad}/index.html`)).status, 404, bad);
    // traversal and symlink escape
    for (const rel of ['../outside.txt', '%2e%2e/outside.txt', '..%2foutside.txt', 'css/..%2f..%2foutside.txt', 'link-out.txt', 'link-dir/x.txt', '.env', '.git/config', '%00', '%zz']) {
      assert.equal((await get(`${key}/${rel}`)).status, 404, rel);
    }
    assert.equal((await get(`${key}/index.html`, { method: 'POST' })).status, 405);
    // the key survives a patch that tries to replace it; closing the window revokes it
    const patched = await h.call('PATCH', `/api/panels/${open.data.id}`, { props: { key: 'c'.repeat(32) } });
    assert.equal(patched.data.props.key, key);
    await h.call('DELETE', `/api/panels/${open.data.id}`);
    assert.equal((await get(`${key}/index.html`)).status, 404);
    assert.equal((await fetch(`${h.base}/api/panels`)).status, 401, 'the token-free route does not open the API');
  } finally { await h.close(); }
});

test('page panels need an HTML path', async () => {
  const h = await startHatch();
  try { assert.equal((await h.call('POST', '/api/panels', { type: 'page', props: {} })).status, 400); } finally { await h.close(); }
});
