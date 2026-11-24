import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { startHatch, sleep } from './helpers.js';
import { createHatch } from '../src/server.js';
import { createSessions, hashId, SESSION_MS } from '../src/sessions.js';
import { createLimiter, clientKey } from '../src/rate-limit.js';
import { createCodes, CODE_ALPHABET } from '../src/login.js';

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

const postCode = (h, c) => fetch(`${h.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${encodeURIComponent(c)}` });

test('one-time login code: format ABCD-EFGH, typed into the form, single use (also concurrently), no code in the log, no link route', async () => {
  const h = await startHatch({ loginLimit: { max: 100 } });
  try {
    const { code, expiresInSec } = (await h.call('POST', '/api/auth/once')).data; assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.equal(expiresInSec, 300);
    assert.equal((await postCode(h, code.replace('-', '') + 'X')).status, 401, 'a wrong code');
    const r = await postCode(h, code);
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/'); assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: cookieOf(r) } })).status, 200);
    const again = await postCode(h, code); assert.equal(again.status, 401); assert.equal(again.headers.get('set-cookie'), null);
    const race = (await h.call('POST', '/api/auth/once')).data.code;
    const rs = await Promise.all(Array.from({ length: 12 }, () => postCode(h, race)));
    assert.equal(rs.filter((x) => x.status === 303).length, 1, 'exactly one of twelve simultaneous requests wins');
    assert.ok(!fs.readFileSync(path.join(h.stateDir, 'log', 'server.log'), 'utf8').includes(code), 'the code is not logged');
    assert.equal((await fetch(`${h.base}/api/auth/once`, { method: 'POST' })).status, 401, 'making codes needs the token');
    const fresh = (await h.call('POST', '/api/auth/once')).data.code;
    const link = await fetch(`${h.base}/login?code=${fresh}`, { redirect: 'manual' }); assert.equal(link.status, 200, 'GET /login?code= is just the login page now'); assert.equal(link.headers.get('set-cookie'), null);
    assert.equal((await postCode(h, fresh)).status, 303, 'and it did not use the code up');
  } finally { await h.close(); }
});

test('one-time code (unit): alphabet and length, normalisation, single use, 5 minute expiry, newer replaces older, clear revokes, junk refused', () => {
  let t = 0; const c = createCodes({ now: () => t });
  for (let i = 0; i < 200; i++) { const x = c.issue().code; assert.match(x, /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{4}$/); c.clear(); }
  assert.equal(new Set(CODE_ALPHABET).size, 32); assert.doesNotMatch(CODE_ALPHABET, /[01IO]/);
  const a = c.issue().code; assert.equal(c.use(a + 'x'), false, 'wrong'); assert.equal(c.use(a), true); assert.equal(c.use(a), false, 'single use');
  const n = c.issue().code; assert.equal(c.use(` ${n.toLowerCase().replace('-', ' - ')}\n`), true, 'case, spaces and dashes are ignored');
  const n2 = c.issue().code; assert.equal(c.use(n2.replace('-', '')), true, 'dash optional');
  const b = c.issue().code; t += 5 * 60 * 1000 - 1; assert.equal(c.use(b), true, 'valid until 5 minutes are over');
  const d = c.issue().code; t += 5 * 60 * 1000; assert.equal(c.use(d), false, 'expired');
  const e = c.issue().code, f = c.issue().code; assert.equal(c.use(e), false, 'replaced by the newer one'); assert.equal(c.use(f), true);
  const g = c.issue().code; assert.equal(c.clear(), 1); assert.equal(c.use(g), false, 'revoked'); assert.equal(c.clear(), 0, 'nothing pending');
  c.issue(); assert.equal(c.use(''), false); assert.equal(c.use('a'.repeat(500)), false); assert.equal(c.use(undefined), false);
});

test('one-time code (unit): 5 wrong attempts in total burn the pending code; a new one works again', () => {
  let burned = 0; const c = createCodes({ onBurn: () => burned++ });
  const a = c.issue().code;
  for (let i = 0; i < 4; i++) assert.equal(c.use('AAAA-AAAA'), false);
  assert.equal(burned, 0); assert.equal(c.use(a), true, 'four failures leave the code alive');
  const b = c.issue().code;
  for (let i = 0; i < 5; i++) assert.equal(c.use('AAAA-AAAA'), false);
  assert.equal(burned, 1); assert.equal(c.use(b), false, 'the correct code is dead after five failures');
  assert.equal(c.use('AAAA-AAAA'), false); assert.equal(burned, 1, 'nothing pending: no second burn');
  const d = c.issue().code; assert.equal(c.use(d), true, 'a new code starts with a clean count');
});

test('one-time code over HTTP: five wrong attempts (any address) kill the code, same message as a plain wrong one, logged without the code', async () => {
  const h = await startHatch({ loginLimit: { max: 100 } });
  try {
    const { code } = (await h.call('POST', '/api/auth/once')).data;
    const msgs = [];
    for (let i = 0; i < 5; i++) { const r = await postCode(h, 'ZZZZ-ZZZZ'); assert.equal(r.status, 401); msgs.push(/did not work: [^<]*/.exec(await r.text())[0]); }
    assert.equal(new Set(msgs).size, 1, 'the same message every time');
    const dead = await postCode(h, code); assert.equal(dead.status, 401); assert.equal(/did not work: [^<]*/.exec(await dead.text())[0], msgs[0], 'burned looks like wrong');
    const log = fs.readFileSync(path.join(h.stateDir, 'log', 'server.log'), 'utf8'); assert.match(log, /login code invalidated/); assert.ok(!log.includes(code));
    const next = (await h.call('POST', '/api/auth/once')).data.code; assert.equal((await postCode(h, next)).status, 303);
  } finally { await h.close(); }
});

test('revoking the one-time code through the API: an unused code stops working; full access only', async () => {
  const h = await startHatch();
  try {
    const { code } = (await h.call('POST', '/api/auth/once')).data;
    assert.equal((await fetch(`${h.base}/api/auth/once`, { method: 'DELETE' })).status, 401, 'revoking needs the token');
    assert.equal((await h.call('DELETE', '/api/auth/once')).data.revoked, 1);
    assert.equal((await postCode(h, code)).status, 401, 'the revoked code is dead');
    assert.equal((await h.call('DELETE', '/api/auth/once')).data.revoked, 0, 'nothing left to revoke');
  } finally { await h.close(); }
});

test('login page: a code form (no script) behind a link; a typed code logs in once, a reused or wrong one fails with the same limiter', async () => {
  const h = await startHatch();
  try {
    const tokenPage = await (await fetch(`${h.base}/login`)).text(); assert.match(tokenPage, /Use a one-time code instead/); assert.match(tokenPage, /href="\/login\?mode=code"/);
    const r = await fetch(`${h.base}/login?mode=code`); const html = await r.text();
    assert.equal(r.status, 200); assert.match(html, /name="code"/); assert.doesNotMatch(html, /type="password"/); assert.doesNotMatch(html, /<script/i); assert.match(html, /Use the token instead/); assert.match(html, /hatch-server code/);
    const code = (await h.call('POST', '/api/auth/once')).data.code;
    const wrong = await postCode(h, 'ZZZZ-ZZZZ'); assert.equal(wrong.status, 401); assert.match(await wrong.text(), /did not work/);
    const ok = await postCode(h, ` ${code.toLowerCase()}\n`); assert.equal(ok.status, 303); assert.equal(ok.headers.get('location'), '/');
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: cookieOf(ok) } })).status, 200);
    const again = await postCode(h, code); assert.equal(again.status, 401); assert.equal(again.headers.get('set-cookie'), null); assert.match(await again.text(), /already used or has expired/);
  } finally { await h.close(); }
});
test('hatch-server CLI: url has no token; token prints it; sessions, logout, rotate-token and code work against the running server', async () => {
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
    const once = await run('code'); const code = once.stdout.trim(); assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.doesNotMatch(once.stdout, /login\?code/, 'no link any more');
    assert.match(once.stderr, /Use a one-time code instead/); assert.match(once.stderr, /5 minutes/); assert.match(once.stderr, /code --revoke/);
    assert.equal((await postCode(h, code)).status, 303);
    const spare = await run('code'); const spareCode = spare.stdout.trim();
    const revoked = await run('code', '--revoke'); assert.equal(revoked.status, 0); assert.match(revoked.stdout, /revoked/);
    assert.equal((await postCode(h, spareCode)).status, 401);
    assert.match((await run('code', '--revoke')).stdout, /no unused/);
    const alias = await run('url', '--once'); assert.match(alias.stderr, /replaced by `hatch-server code`/); assert.match(alias.stdout.trim(), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const aliasRev = await run('url', '--revoke-once'); assert.match(aliasRev.stderr, /code --revoke/); assert.match(aliasRev.stdout, /revoked/);
    const out = await run('logout', '--all'); assert.match(out.stdout, /ended 2 logins/);
    const old = h.hatch.token; const rot = await run('rotate-token'); const fresh = rot.stdout.trim(); assert.match(fresh, /^[a-f0-9]{32}$/); assert.notEqual(fresh, old);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': fresh } })).status, 200); assert.ok(!rot.stderr.includes(fresh), 'printed once, on stdout only');
  } finally { await h.close(); }
});

test('hatch-server CLI without a running server: sessions, logout and rotate-token edit the files; code says the server must run', async () => {
  const h = await startHatch(); const home = path.dirname(h.stateDir);
  const id = sid(await fetch(`${h.base}/login`, form(h.hatch.token))); const old = h.hatch.token; await h.close();
  const run = (...a) => cli([...a, '--state', h.stateDir], home);
  assert.match((await run('sessions')).stdout, new RegExp(hashId(id).slice(0, 8)));
  assert.match((await run('code', '--revoke')).stdout, /not running/);
  assert.equal((await run('code')).status, 1); assert.match((await run('code')).stderr, /not running/);
  assert.equal((await run('url', '--once')).status, 1);
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

test('panic: sessions, token, view token, pending link and hosted-page secrets all stop; other config keys stay; the answer has no token', async () => {
  const h = await startHatch();
  try {
    const old = h.hatch.token; const session = sid(await fetch(`${h.base}/login`, form(old)));
    const cfgFile = path.join(h.stateDir, 'config.json'); const view = 'v'.repeat(32);
    fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), allowedHosts: ['box.example'], viewToken: view }));
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': view } })).status, 200, 'the view token works before');
    const { code } = (await h.call('POST', '/api/auth/once')).data;
    const r = await h.call('POST', '/api/auth/panic'); assert.equal(r.status, 200); assert.deepEqual(r.data, { ended: 1, links: 1, view: true });
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); assert.match(cfg.token, /^[a-f0-9]{32}$/); assert.notEqual(cfg.token, old); assert.equal(cfg.viewToken, undefined); assert.deepEqual(cfg.allowedHosts, ['box.example']); assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o600);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': cfg.token } })).status, 200);
    for (const bad of [{ 'x-token': old }, { 'x-token': view }, { cookie: `hatch_session=${session}` }]) assert.equal((await fetch(`${h.base}/api/health`, { headers: bad })).status, 401);
    assert.equal((await postCode(h, code)).status, 401, 'the pending code is dead');
  } finally { await h.close(); }
});

test('hatch-server panic and hatch panic: with a server and without one; the new token is never printed', async () => {
  const h = await startHatch(); const home = path.dirname(h.stateDir); const cfgFile = path.join(h.stateDir, 'config.json');
  const HATCH = new URL('../bin/hatch.js', import.meta.url).pathname;
  const run = (...a) => cli([...a, '--state', h.stateDir], home);
  const old = h.hatch.token; const session = sid(await fetch(`${h.base}/login`, form(old)));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), viewToken: 'w'.repeat(32) }));
  const out = await run('panic'); const fresh = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).token;
  assert.equal(out.status, 0); assert.match(out.stdout, /PANIC done \(server running\): 1 login ended, token rolled, view token removed/); assert.ok(!out.stdout.includes(fresh) && !out.stderr.includes(fresh)); assert.match(out.stdout, /config\.json/);
  assert.notEqual(fresh, old); assert.equal((await fetch(`${h.base}/api/health`, { headers: { cookie: `hatch_session=${session}` } })).status, 401);
  const viaHatch = await new Promise((resolve) => execFile('node', [HATCH, 'panic', '--state', h.stateDir], { env: { ...process.env, HOME: home, HATCH_STATE: '', HATCH_URL: '' } }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
  assert.equal(viaHatch.status, 0); assert.match(viaHatch.stdout, /PANIC done/);
  const second = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).token; assert.notEqual(second, fresh);
  await h.close();
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), viewToken: 'z'.repeat(32) }));
  const off = await run('panic'); const third = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(off.status, 0); assert.match(off.stdout, /server not running, files edited\): 0 logins ended, token rolled, view token removed/); assert.notEqual(third.token, second); assert.equal(third.viewToken, undefined); assert.ok(!off.stdout.includes(third.token));
  assert.match((await run('--help')).stdout, /hatch-server panic/);
});
