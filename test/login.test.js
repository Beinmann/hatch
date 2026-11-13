import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startHatch, sleep } from './helpers.js';
import { createHatch } from '../src/server.js';
import { createSessions, hashId, SESSION_MS } from '../src/sessions.js';
import { createLimiter, clientKey } from '../src/rate-limit.js';
import { createCodes } from '../src/login.js';

const HATCH_SERVER = new URL('../bin/hatch-server.js', import.meta.url).pathname;
// async on purpose: the server under test runs in this process, so a blocking spawnSync could never get an answer
const cli = (args, home) => new Promise((resolve) => execFile('node', [HATCH_SERVER, ...args], { env: { ...process.env, HOME: home, HATCH_STATE: '', HATCH_URL: '' } }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
const form = (token) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(token)}` });
const sid = (r) => /hatch_session=([a-f0-9]{64})/.exec(r.headers.get('set-cookie'))?.[1];
const cookieOf = (r) => `hatch_session=${sid(r)}`;

test('/login is served without a login: a password field, no script, the page CSP, no caching', async () => {
  const h = await startHatch();
  try {
    const r = await fetch(`${h.base}/login`); const html = await r.text();
    assert.equal(r.status, 200); assert.match(html, /type="password"/); assert.doesNotMatch(html, /<script/i);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await fetch(`${h.base}/`)).status, 401, 'the rest still needs a login');
    assert.match(await (await fetch(`${h.base}/`)).text(), /href="\/login"|\/login/, 'the 401 page leads to the login');
  } finally { await h.close(); }
});

test('login: the right token gives a session cookie (not the token) and goes to /; a wrong one gets one generic answer and no cookie', async () => {
  const h = await startHatch();
  try {
    const bad = await fetch(`${h.base}/login`, form('wrong-wrong-wrong-wrong')); const badText = await bad.text();
    assert.equal(bad.status, 401); assert.equal(bad.headers.get('set-cookie'), null); assert.match(badText, /That token did not work/);
    const empty = await fetch(`${h.base}/login`, { method: 'POST', redirect: 'manual' });
    assert.equal(empty.status, 401); assert.equal(await empty.text(), badText, 'a missing, a short and a wrong token look the same');
    const ok = await fetch(`${h.base}/login`, form(h.hatch.token));
    assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/');
    const set = ok.headers.get('set-cookie'); assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Path=\//); assert.match(set, /Max-Age=2592000/); assert.doesNotMatch(set, /Secure/);
    assert.ok(sid(ok)); assert.notEqual(sid(ok), h.hatch.token);
    const page = await fetch(`${h.base}/`, { headers: { cookie: cookieOf(ok) } }); assert.equal(page.status, 200); assert.match(await page.text(), /<title>Hatch<\/title>/);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: cookieOf(ok) } })).status, 200);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${'0'.repeat(64)}` } })).status, 401, 'a made-up session id');
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${h.hatch.token}` } })).status, 401, 'the token is not a session id');
  } finally { await h.close(); }
});

test('login: Secure cookie behind an HTTPS proxy (X-Forwarded-Proto), plain otherwise', async () => {
  const h = await startHatch();
  try {
    const r = await fetch(`${h.base}/login`, { ...form(h.hatch.token), headers: { ...form('').headers, 'x-forwarded-proto': 'https' } });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
  } finally { await h.close(); }
});

test('sessions are stored hashed (mode 0600), survive a restart, and the log never holds the token or a session id', async () => {
  const h = await startHatch();
  let h2;
  try {
    const ok = await fetch(`${h.base}/login`, form(h.hatch.token)); const id = sid(ok);
    const file = path.join(h.stateDir, 'sessions.json'); const text = fs.readFileSync(file, 'utf8');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.ok(text.includes(hashId(id))); assert.ok(!text.includes(id), 'only the hash is stored');
    await h.close();
    h2 = createHatch({ stateDir: h.stateDir, host: '127.0.0.1', port: 0, attach: ['cat'], cwd: h.dir, findBin: () => null });
    const port = await h2.listen();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { cookie: `hatch_session=${id}` } })).status, 200, 'still logged in after a restart');
    const log = fs.readFileSync(path.join(h.stateDir, 'log', 'server.log'), 'utf8'); assert.ok(!log.includes(id) && !log.includes(h.hatch.token));
  } finally { await h2?.close(); }
});

test('sessions: expiry, revoke by id prefix, revoke all, bounded count (fake clock)', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'hatch-sess-')); const file = path.join(dir, 's.json'); let t = 1_000_000;
  const s = createSessions({ file, now: () => t });
  const a = s.create('one').id; const b = s.create('two').id;
  assert.ok(s.check(a) && s.check(b)); assert.equal(s.list().length, 2);
  assert.equal(s.check('x'.repeat(64)), false); assert.equal(s.check(undefined), false);
  t += SESSION_MS - 1; assert.ok(s.check(a), 'valid until the 30th day is over');
  t += 2; assert.equal(s.check(a), false, 'expired'); assert.equal(s.list().length, 0, 'and dropped');
  s.flush(); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 0);
  const c = s.create().id; const d = s.create().id;
  assert.throws(() => s.revoke('ab'), /at least 4/);
  assert.equal(s.revoke(hashId(c).slice(0, 8)), 1); assert.equal(s.check(c), false); assert.ok(s.check(d));
  assert.equal(s.revoke('ffff'.repeat(2)), 0, 'unknown prefix ends nothing');
  assert.equal(s.revokeAll(), 1); assert.equal(s.check(d), false);
  for (let i = 0; i < 230; i++) s.create(); assert.ok(s.size <= 200, 'bounded');
  fs.writeFileSync(file, '{not json'); const warned = []; createSessions({ file, warn: (m) => warned.push(m) }); assert.match(warned[0], /not valid JSON/);
  fs.rmSync(dir, { recursive: true });
});

test('revoking a session through the API ends it; so does rotating the token; the API needs full access', async () => {
  const h = await startHatch();
  try {
    const one = sid(await fetch(`${h.base}/login`, form(h.hatch.token))); const two = sid(await fetch(`${h.base}/login`, form(h.hatch.token)));
    const list = (await h.call('GET', '/api/auth/sessions')).data; assert.equal(list.length, 2); assert.match(list[0].id, /^[a-f0-9]{8}$/); assert.ok(!JSON.stringify(list).includes(one));
    assert.equal((await h.call('DELETE', `/api/auth/sessions/${hashId(one).slice(0, 8)}`)).status, 200);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${one}` } })).status, 401);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${two}` } })).status, 200);
    assert.equal((await h.call('DELETE', '/api/auth/sessions/abcd1234')).status, 404);
    assert.equal((await h.call('DELETE', '/api/auth/sessions/ab')).status, 400);
    assert.equal((await h.call('DELETE', '/api/auth/sessions')).data.ended, 1);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${two}` } })).status, 401);
    assert.equal((await fetch(`${h.base}/api/auth/sessions`)).status, 401);
  } finally { await h.close(); }
});

test('rotate-token: new token works, the old one and every session stop; other config keys stay; file is 0600', async () => {
  const h = await startHatch();
  try {
    const old = h.hatch.token; const session = sid(await fetch(`${h.base}/login`, form(old)));
    const cfgFile = path.join(h.stateDir, 'config.json'); fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), allowedHosts: ['box.example'] }));
    const r = await h.call('POST', '/api/auth/rotate-token'); assert.equal(r.status, 200); assert.match(r.data.token, /^[a-f0-9]{32}$/); assert.notEqual(r.data.token, old);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); assert.equal(cfg.token, r.data.token); assert.deepEqual(cfg.allowedHosts, ['box.example']); assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': r.data.token } })).status, 200, 'the running server picked it up');
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': old } })).status, 401);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${session}` } })).status, 401);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_token=${old}` } })).status, 401, 'nor the legacy cookie');
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'sessions.json'), 'utf8')).sessions.length, 0);
  } finally { await h.close(); }
});

test('rate limit: failed token checks lock the address out (no oracle: the right token is refused too), sessions are never blocked, and it ends', async () => {
  const h = await startHatch({ loginLimit: { max: 3, baseMs: 400 } });
  try {
    const session = sid(await fetch(`${h.base}/login`, form(h.hatch.token)));
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': 'wrong-wrong-wrong-wrong' } })).status, 401);
    const locked = await fetch(`${h.base}/api/health`, { headers: { 'x-token': h.hatch.token } });
    assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(`${h.base}/login`, form(h.hatch.token))).status, 429, 'the login form too');
    assert.equal((await fetch(`${h.base}/?t=${h.hatch.token}`, { redirect: 'manual' })).status, 429, 'and the ?t= link');
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${session}` } })).status, 200, 'a logged-in browser is not affected');
    assert.equal((await fetch(`${h.base}/login`)).status, 200, 'the login page itself is still shown');
    assert.match(fs.readFileSync(path.join(h.stateDir, 'log', 'server.log'), 'utf8'), /login locked: local may not try again/);
    await sleep(450);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': h.hatch.token } })).status, 200, 'the lockout ends');
  } finally { await h.close(); }
});

test('rate limit: wrong ?t= and wrong login forms count; the lockout grows; memory is bounded; a proxy is told apart only from loopback', () => {
  let t = 0; const lim = createLimiter({ max: 2, baseMs: 1000, maxLockMs: 4000, forgetMs: 60000, maxEntries: 50, now: () => t });
  assert.equal(lim.fail('a'), 0); assert.equal(lim.fail('a'), 1000); assert.equal(lim.wait('a'), 1000);
  t += 1000; assert.equal(lim.wait('a'), 0); assert.equal(lim.fail('a'), 2000); t += 2000; assert.equal(lim.fail('a'), 4000); t += 4000; assert.equal(lim.fail('a'), 4000, 'capped');
  t += 61000; assert.equal(lim.fail('a'), 0, 'forgotten after a quiet period');
  for (let i = 0; i < 500; i++) lim.fail(`k${i}`); assert.ok(lim.size <= 50);
  const req = (addr, xff) => ({ socket: { remoteAddress: addr }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientKey(req('::ffff:192.0.2.7', '1.2.3.4')), '192.0.2.7', 'a header from the network is ignored');
  assert.equal(clientKey(req('127.0.0.1')), 'local'); assert.equal(clientKey(req('127.0.0.1', 'spoof, 198.51.100.9')), 'via-proxy:198.51.100.9', 'the proxy\'s own (last) entry');
});

test('one-time login code: logs in once, redirects to the clean URL with safe headers, cannot be reused (also concurrently), no code in the log', async () => {
  const h = await startHatch();
  try {
    const { code, expiresInSec } = (await h.call('POST', '/api/auth/once')).data; assert.ok(code.length >= 27); assert.equal(expiresInSec, 300);
    assert.equal((await fetch(`${h.base}/login?code=${code}x`, { redirect: 'manual' })).status, 401, 'a wrong code');
    const r = await fetch(`${h.base}/login?code=${code}`, { redirect: 'manual' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: cookieOf(r) } })).status, 200);
    const again = await fetch(`${h.base}/login?code=${code}`, { redirect: 'manual' }); assert.equal(again.status, 401); assert.equal(again.headers.get('set-cookie'), null);
    const race = (await h.call('POST', '/api/auth/once')).data.code;
    const rs = await Promise.all(Array.from({ length: 12 }, () => fetch(`${h.base}/login?code=${race}`, { redirect: 'manual' })));
    assert.equal(rs.filter((x) => x.status === 302).length, 1, 'exactly one of twelve simultaneous requests wins');
    assert.ok(!fs.readFileSync(path.join(h.stateDir, 'log', 'server.log'), 'utf8').includes(code), 'the code is not logged');
    assert.equal((await fetch(`${h.base}/api/auth/once`, { method: 'POST' })).status, 401, 'making codes needs the token');
  } finally { await h.close(); }
});

test('one-time codes: expire after 5 minutes, stay bounded, are not kept in plain text', () => {
  let t = 0; const c = createCodes({ now: () => t, max: 3 });
  const a = c.issue().code; t += 5 * 60 * 1000 - 1; assert.equal(c.use(a), true); const b = c.issue().code; t += 5 * 60 * 1000; assert.equal(c.use(b), false, 'expired');
  for (let i = 0; i < 10; i++) c.issue(); assert.ok(c.size <= 3);
  assert.equal(c.use(''), false); assert.equal(c.use('a'.repeat(500)), false); assert.equal(c.use(undefined), false);
});

test('old links and cookies keep working during the move: ?t= starts a session and drops the query; the raw-token cookie becomes a session', async () => {
  const h = await startHatch();
  try {
    const r = await fetch(`${h.base}/some/page?t=${h.hatch.token}&x=1`, { redirect: 'manual' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/some/page', 'no token in the address after the redirect');
    const sets = r.headers.get('set-cookie'); assert.ok(sid(r)); assert.ok(!sets.includes(`hatch_session=${h.hatch.token}`)); assert.match(sets, /hatch_token=;[^,]*Max-Age=0/, 'the raw-token cookie is deleted');
    const legacy = { cookie: `hatch_token=${h.hatch.token}` };
    const api = await fetch(`${h.base}/api/health`, { headers: legacy }); assert.equal(api.status, 200); assert.equal(api.headers.get('set-cookie'), null, 'API calls are left alone');
    const nav = await fetch(`${h.base}/`, { headers: { ...legacy, accept: 'text/html' } });
    assert.equal(nav.status, 200); assert.ok(sid(nav), 'a page load upgrades the cookie'); assert.match(nav.headers.get('set-cookie'), /hatch_token=;/);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: cookieOf(nav) } })).status, 200);
    const stale = await fetch(`${h.base}/`, { headers: { cookie: 'hatch_token=old-old-old-old-old-old' } }); assert.equal(stale.status, 401); assert.match(stale.headers.get('set-cookie'), /hatch_token=;/, 'a stale cookie is dropped');
  } finally { await h.close(); }
});

test('hatch-server CLI: url has no token; token prints it; sessions, logout, rotate-token and url --once work against the running server', async () => {
  const h = await startHatch(); const home = path.dirname(h.stateDir);
  const run = (...a) => cli([...a, '--state', h.stateDir], home);
  try {
    const url = await run('url'); assert.equal(url.status, 0); assert.match(url.stdout.trim(), /^http:\/\/[\d.]+:\d+\/$/); assert.ok(!url.stdout.includes(h.hatch.token) && !url.stderr.includes(h.hatch.token));
    assert.equal((await run('token')).stdout.trim(), h.hatch.token);
    const s1 = sid(await fetch(`${h.base}/login`, form(h.hatch.token))); sid(await fetch(`${h.base}/login`, form(h.hatch.token)));
    const list = await run('sessions'); assert.equal(list.status, 0); assert.match(list.stdout, /ID\s+CREATED\s+LAST SEEN/); assert.equal(list.stdout.trim().split('\n').length, 3);
    assert.ok(!list.stdout.includes(s1));
    await run('logout', hashId(s1).slice(0, 8));
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${s1}` } })).status, 401);
    assert.equal((await run('logout', 'zz')).status, 1);
    const once = await run('url', '--once'); const link = /(http:\/\/\S+\/login\?code=\S+)/.exec(once.stdout)[1];
    const used = await fetch(link.replace(/^http:\/\/[\d.]+:\d+/, h.base), { redirect: 'manual' }); assert.equal(used.status, 302);
    const out = await run('logout', '--all'); assert.match(out.stdout, /ended 2 logins/);
    const old = h.hatch.token; const rot = await run('rotate-token'); const fresh = rot.stdout.trim(); assert.match(fresh, /^[a-f0-9]{32}$/); assert.notEqual(fresh, old);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': fresh } })).status, 200); assert.ok(!rot.stderr.includes(fresh), 'printed once, on stdout only');
  } finally { await h.close(); }
});

test('hatch-server CLI without a running server: sessions, logout and rotate-token edit the files; --once says the server must run', async () => {
  const h = await startHatch(); const home = path.dirname(h.stateDir);
  const id = sid(await fetch(`${h.base}/login`, form(h.hatch.token))); const old = h.hatch.token; await h.close();
  const run = (...a) => cli([...a, '--state', h.stateDir], home);
  assert.match((await run('sessions')).stdout, new RegExp(hashId(id).slice(0, 8)));
  assert.equal((await run('url', '--once')).status, 1); assert.match((await run('url', '--once')).stderr, /not running/);
  const rot = await run('rotate-token'); const fresh = rot.stdout.trim(); assert.notEqual(fresh, old); assert.equal(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'config.json'), 'utf8')).token, fresh);
  assert.match((await run('sessions')).stdout, /no browser is logged in/);
});

test('ending a session closes its open event stream within about 5 seconds; a stream that used the x-token header keeps running', async () => {
  const h = await startHatch();
  try {
    const id = sid(await fetch(`${h.base}/login`, form(h.hatch.token)));
    const ended = (async (headers) => { const r = await fetch(`${h.base}/api/events`, { headers, signal: AbortSignal.timeout(9000) }); try { for await (const c of r.body) void c; return true; } catch { return false; } });
    const sessionStream = ended({ cookie: `hatch_session=${id}` }); const tokenStream = ended({ 'x-token': h.hatch.token });
    await sleep(400); h.hatch.sessions.revokeAll();
    assert.equal(await sessionStream, true, 'the session stream ended by itself');
    assert.equal(await tokenStream, false, 'the x-token stream was still open when the timeout aborted it');
  } finally { await h.close(); }
});
