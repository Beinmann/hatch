import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHatch, tmp } from './helpers.js';
import { injectBase } from '../src/host-inject.js';
import { createHostSecrets } from '../src/host-secrets.js';

const BASE = '/host-r/0123456789abcdef0123456789abcdef/aabbccddee/';
const inject = (html, b = BASE) => { const r = injectBase(Buffer.from(html, 'latin1'), b); return { ...r, text: r.body.toString('latin1') }; };

function site() {
  const d = tmp(); const s = path.join(d, 'site'); fs.mkdirSync(path.join(s, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(s, 'page.html'), '<!doctype html><html><head><title>t</title><link rel=stylesheet href=style.css></head><body><h1>hi</h1><script src=app.js></script></body></html>');
  fs.writeFileSync(path.join(s, 'style.css'), 'h1{color:red}'); fs.writeFileSync(path.join(s, 'app.js'), 'window.x=1');
  fs.writeFileSync(path.join(s, 'sub', 'a.txt'), 'inner'); fs.writeFileSync(path.join(s, '.secret'), 'nope');
  fs.writeFileSync(path.join(d, 'outside.txt'), 'outside'); fs.symlinkSync(path.join(d, 'outside.txt'), path.join(s, 'leak.txt')); fs.symlinkSync(d, path.join(s, 'up'));
  return { d, s };
}
const login = async (h) => { const r = await fetch(`${h.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${h.hatch.token}` }); return { cookie: `hatch_session=${/hatch_session=([a-f0-9]+)/.exec(r.headers.get('set-cookie'))[1]}` }; };
const baseOf = (html) => /<base href="([^"]+)">/.exec(html)[1];

test('hosted page: needs the login cookie (401 page that says so), then is served sandboxed with a per-load secret base; the link has no secret', async () => {
  const { s } = site(); const h = await startHatch();
  try {
    const r = (await h.call('POST', '/api/host', { file: path.join(s, 'page.html') })).data;
    assert.match(r.path, /^\/host\/[0-9a-f]{10}\/page\.html$/);
    const anon = await fetch(h.base + r.path); const msg = await anon.text();
    assert.equal(anon.status, 401); assert.match(msg, /not logged in to Hatch in this browser/); assert.doesNotMatch(msg, /host-r/);
    assert.equal((await fetch(`${h.base}${r.path}`, { headers: { 'x-token': 'wrong-wrong-wrong-wrong' } })).status, 401);
    const cookie = await login(h);
    const page = await fetch(h.base + r.path, { headers: cookie }); const html = await page.text();
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('content-security-policy'), "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'");
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.equal(Number(page.headers.get('content-length')), Buffer.byteLength(html, 'latin1'));
    const b = baseOf(html); assert.equal(b, `/host-r/${/host-r\/([a-f0-9]{32})\//.exec(b)[1]}/${r.id}/`);
    assert.ok(html.indexOf('<base') < html.indexOf('<title>'), 'the base is the first thing in <head>');
    assert.notEqual(baseOf(await (await fetch(h.base + r.path, { headers: cookie })).text()), b, 'every load gets its own secret');
    assert.equal((await fetch(h.base + r.path, { method: 'POST', headers: cookie })).status, 405);
    assert.equal((await fetch(h.base + r.path, { method: 'HEAD', headers: cookie })).status, 200);
  } finally { await h.close(); }
});

test('hosted sub-resources: served by the secret path without a cookie, read-only, sandboxed, with the safe headers; wrong secret, other id, escapes and dotfiles are 404', async () => {
  const { s } = site(); const h = await startHatch();
  try {
    const r = (await h.call('POST', '/api/host', { file: path.join(s, 'page.html') })).data; const other = (await h.call('POST', '/api/host', { file: path.join(s, 'style.css') })).data;
    const base = baseOf(await (await fetch(h.base + r.path, { headers: await login(h) })).text());
    const css = await fetch(h.base + base + 'style.css');
    assert.equal(css.status, 200); assert.equal(await css.text(), 'h1{color:red}'); assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(css.headers.get('content-security-policy'), /^sandbox /); assert.equal(css.headers.get('referrer-policy'), 'no-referrer'); assert.equal(css.headers.get('cache-control'), 'no-store'); assert.equal(css.headers.get('access-control-allow-origin'), '*'); assert.equal(css.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await (await fetch(h.base + base + 'sub/a.txt')).text(), 'inner');
    assert.equal(await (await fetch(h.base + base)).text().then((t) => t.includes('<h1>hi')), true, 'the folder URL shows the entry file');
    assert.equal((await fetch(h.base + base + 'style.css', { method: 'HEAD' })).status, 200);
    for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(h.base + base + 'style.css', { method: m })).status, 405, m);
    for (const bad of ['..%2foutside.txt', '../outside.txt', 'leak.txt', 'up/outside.txt', '.secret', 'sub', '%2e%2e/outside.txt', '..%5coutside.txt', 'a%00.css', '%zz', 'missing.css']) assert.equal((await fetch(h.base + base + bad)).status, 404, bad);
    const secret = /host-r\/([a-f0-9]{32})\//.exec(base)[1];
    assert.equal((await fetch(`${h.base}/host-r/${secret}/${other.id}/style.css`)).status, 404, 'the secret belongs to one page');
    assert.equal((await fetch(`${h.base}/host-r/${'0'.repeat(32)}/${r.id}/style.css`)).status, 404, 'a made-up secret');
    assert.equal((await fetch(`${h.base}/host-r/${r.id}/style.css`)).status, 404); assert.equal((await fetch(`${h.base}/host-r/`)).status, 404);
    assert.equal((await fetch(`${h.base}/host-r/${secret.toUpperCase()}/${r.id}/style.css`)).status, 404);
    // the cookie-based route is not open without the cookie
    assert.equal((await fetch(`${h.base}/host/${r.id}/style.css`)).status, 401);
    // un-hosting, and rotating the token, end the secret
    assert.equal((await h.call('DELETE', `/api/host/${r.id}`)).status, 200); assert.equal((await fetch(h.base + base + 'style.css')).status, 404);
    const r2 = (await h.call('POST', '/api/host', { file: path.join(s, 'page.html') })).data;
    const b2 = baseOf(await (await fetch(h.base + r2.path, { headers: await login(h) })).text()); assert.equal((await fetch(h.base + b2 + 'style.css')).status, 200);
    await h.call('POST', '/api/auth/rotate-token'); assert.equal((await fetch(h.base + b2 + 'style.css')).status, 404, 'rotate-token ends secrets too');
  } finally { await h.close(); }
});

test('hosted pages: a view-only link may still read them (unchanged); a page above the size limit is refused', async () => {
  const { s } = site(); const h = await startHatch();
  try {
    const r = (await h.call('POST', '/api/host', { file: path.join(s, 'page.html') })).data;
    const view = 'v'.repeat(32); const cfgFile = path.join(h.stateDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), viewToken: view }));
    assert.equal((await fetch(h.base + r.path, { headers: { 'x-token': view } })).status, 200);
    const big = path.join(s, 'big.html'); fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 32));
    const rb = (await h.call('POST', '/api/host', { file: big })).data; assert.equal((await fetch(h.base + rb.path, { headers: { 'x-token': h.hatch.token } })).status, 413);
  } finally { await h.close(); }
});

test('host secrets: bound to a page, idle expiry that a use extends, hard limit, bounded count, dropped with the page (fake clock)', () => {
  let t = 0; const hs = createHostSecrets({ now: () => t, idleMs: 600000, maxMs: 3600000, max: 5 });
  try {
    const a = hs.issue('p1');
    assert.equal(hs.check(a, 'p1'), true); assert.equal(hs.check(a, 'p2'), false, 'bound to its page');
    t += 599000; assert.equal(hs.check(a, 'p1'), true, 'a use extends'); t += 599000; assert.equal(hs.check(a, 'p1'), true);
    t += 601000; assert.equal(hs.check(a, 'p1'), false, 'idle for 10 minutes');
    const b = hs.issue('p1'); for (let i = 0; i < 59; i++) { t += 59000; assert.equal(hs.check(b, 'p1'), true); } t += 400000; assert.equal(hs.check(b, 'p1'), false, 'the hard limit ends it even while in use');
    const first = hs.issue('x'); for (let i = 0; i < 10; i++) hs.issue('x'); assert.ok(hs.size <= 5); assert.equal(hs.check(first, 'x'), false, 'the oldest went');
    const c = hs.issue('gone'); hs.dropId('gone'); assert.equal(hs.check(c, 'gone'), false);
    for (const bad of [undefined, '', 'zz', 'A'.repeat(32), 'a'.repeat(31)]) assert.equal(hs.check(bad, 'p1'), false);
  } finally { hs.close(); }
});

test('injectBase: first in <head>, also without a head, after the doctype, with a BOM; bytes of other encodings stay as they are', () => {
  let r = inject('<!doctype html><html><head><meta charset=utf-8><title>x</title></head><body>b</body></html>');
  assert.ok(r.injected); assert.match(r.text, /<head><base href="\/host-r\/[a-f0-9]{32}\/aabbccddee\/"><script>/); assert.ok(r.text.endsWith('<body>b</body></html>'));
  assert.match(inject('<HEAD lang=x><title>x</title>').text, /<HEAD lang=x><base /);
  assert.match(inject('<!doctype html><html lang=en><title>x</title><p>y').text, /<html lang=en><head><base [^>]+><script>.*<\/script><title>x<\/title>/s);
  assert.match(inject('<!DOCTYPE html>\n<h1>x</h1>').text, /^<!DOCTYPE html><base /); assert.match(inject('<h1>x</h1>').text, /^<base /);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<h1>x</h1>')]); assert.deepEqual([...injectBase(bom, BASE).body.subarray(0, 8)], [0xef, 0xbb, 0xbf, ...Buffer.from('<base ').subarray(0, 5)]);
  const latin = Buffer.from([...Buffer.from('<head><title>'), 0xe9, 0xff, ...Buffer.from('</title></head>')]); const out = injectBase(latin, BASE).body;
  assert.ok(out.includes(Buffer.from([0xe9, 0xff])), 'non-UTF-8 bytes are untouched');
  const u16 = Buffer.from([0xff, 0xfe, 0x3c, 0x00]); assert.equal(injectBase(u16, BASE).injected, false); assert.equal(injectBase(u16, BASE).body, u16);
  assert.ok(!inject('<body><script>var s="<head>"</script>').text.startsWith('<body><script>var s="<head>"'), 'a <head> text inside the body is not taken for the head');
});

test('injectBase: an existing <base> is folded in (relative), dropped (root-relative) or respected (absolute)', () => {
  let r = inject('<head><base href="assets/"><title>x</title>');
  assert.match(r.text, /<base href="\/host-r\/[a-f0-9]{32}\/aabbccddee\/assets\/"><script>/); assert.doesNotMatch(r.text, /<base href="assets/);
  assert.match(inject('<head><base href="../../x/">').text, /<base href="\/host-r\/0123456789abcdef0123456789abcdef\/aabbccddee\/">/, 'cannot climb out of the folder');
  r = inject('<head><base href="/static/" target="_blank">'); assert.match(r.text, /<base href="\/host-r[^>]*><script>.*<base target="_blank">/s); assert.doesNotMatch(r.text, /\/static\//);
  r = inject('<head><base href="https://cdn.example/x/"><title>x</title>'); assert.equal(r.injected, false); assert.match(r.text, /^<head><base href="https:\/\/cdn\.example\/x\/">/);
  assert.equal(inject('<head><base href="//cdn.example/x/">').injected, false);
});
