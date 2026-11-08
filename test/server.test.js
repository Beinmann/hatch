import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startHatch, readSse, waitFor, PNG } from './helpers.js';

const hasPython = spawnSync('python3', ['-V']).status === 0;
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('token is enforced; ?t= sets a cookie; wrong Host is rejected', async () => {
  const h = await startHatch();
  try {
    assert.equal((await fetch(`${h.base}/api/health`)).status, 401);
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': 'wrong-wrong-wrong-wrong' } })).status, 401);
    assert.equal((await h.call('GET', '/api/health')).status, 200);
    const r = await fetch(`${h.base}/?t=${h.hatch.token}`, { redirect: 'manual' });
    assert.equal(r.status, 302); assert.match(r.headers.get('set-cookie'), /hatch_token=.*SameSite=Strict/);
    const page = await fetch(`${h.base}/`, { headers: { cookie: `hatch_token=${h.hatch.token}` } });
    assert.equal(page.status, 200); assert.match(await page.text(), /<title>Hatch<\/title>/);
    assert.equal((await fetch(`${h.base}/`)).status, 401);
    const bad = await fetch(`${h.base}/api/health`, { headers: { 'x-token': h.hatch.token, host: 'evil.example' } }).catch((e) => e);
    // fetch forbids overriding Host in undici; use a raw request instead
    const http = await import('node:http');
    const status = await new Promise((res) => { const q = http.request({ host: '127.0.0.1', port: h.port, path: '/api/health', headers: { host: 'evil.example', 'x-token': h.hatch.token } }, (x) => { x.resume(); res(x.statusCode); }); q.end(); });
    assert.equal(status, 403); void bad;
  } finally { await h.close(); }
});

test('terminal: input is echoed on the stream; a late client gets the replay; resize works', { skip: !hasPython }, async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('GET', '/api/term')).data.running, true);
    const first = readSse(`${h.base}/api/term/stream`, { 'x-token': h.hatch.token }, (ev) => Buffer.concat(ev.filter((e) => e.event === 'message').map((e) => Buffer.from(e.data, 'base64'))).toString().includes('hello-hatch'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await h.call('POST', '/api/term/input', { data: 'hello-hatch\n' })).status, 200);
    assert.ok((await first).length > 0);
    const late = await readSse(`${h.base}/api/term/stream`, { 'x-token': h.hatch.token }, (ev) => ev.length > 0);
    assert.ok(Buffer.from(late[0].data, 'base64').toString().includes('hello-hatch'), 'replay contains earlier output');
    assert.equal((await h.call('POST', '/api/term/resize', { cols: 90, rows: 30 })).data.cols, 90);
    assert.equal((await h.call('POST', '/api/term/resize', { cols: 0, rows: 30 })).status, 400);
    assert.equal((await h.call('POST', '/api/term/input', { data: 5 })).status, 400);
  } finally { await h.close(); }
});

test('terminal: when the pty ends the stream says exit and the next connection reattaches', { skip: !hasPython }, async () => {
  const h = await startHatch();
  try {
    await h.call('GET', '/api/term');
    const stream = readSse(`${h.base}/api/term/stream`, { 'x-token': h.hatch.token }, (ev) => ev.some((e) => e.event === 'exit'), 5000);
    await new Promise((r) => setTimeout(r, 300));
    await h.call('POST', '/api/term/input', { data: '\x04' }); // Ctrl+D ends cat
    assert.ok((await stream).some((e) => e.event === 'exit'));
    assert.equal((await h.call('GET', '/api/term')).data.running, true, 'attach restarted');
  } finally { await h.close(); }
});

test('upload: saves a PNG, rejects other content, serves it back', async () => {
  const h = await startHatch();
  try {
    const up = await h.call('POST', '/api/upload', PNG, { 'x-filename': 'shot.png', 'content-type': 'image/png' });
    assert.equal(up.status, 200); assert.ok(path.isAbsolute(up.data.path)); assert.ok(fs.existsSync(up.data.path)); assert.equal(up.data.name, '1.png');
    assert.equal((await h.call('POST', '/api/upload', Buffer.from('<script>'), { 'content-type': 'image/png' })).status, 415);
    const img = await fetch(`${h.base}${up.data.url}`, { headers: { 'x-token': h.hatch.token } });
    assert.equal(img.headers.get('content-type'), 'image/png'); assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    const viaPath = await fetch(`${h.base}/api/file?path=${encodeURIComponent(up.data.path)}`, { headers: { 'x-token': h.hatch.token } });
    assert.equal(viaPath.status, 200);
    const txt = path.join(h.dir, 'a.txt'); fs.writeFileSync(txt, 'secret');
    assert.equal((await fetch(`${h.base}/api/file?path=${encodeURIComponent(txt)}`, { headers: { 'x-token': h.hatch.token } })).status, 415);
    assert.equal((await h.call('GET', '/api/file?path=relative.png')).status, 400);
  } finally { await h.close(); }
});

test('panels: API creates, patches, deletes; the event stream sends a snapshot then changes', async () => {
  const h = await startHatch();
  try {
    const events = readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (ev) => ev.some((e) => e.event === 'panel' && /removed/.test(e.data)), 5000);
    await new Promise((r) => setTimeout(r, 200));
    const made = await h.call('POST', '/api/panels', { type: 'note', title: 'T', props: { markdown: '# hi' } });
    assert.equal(made.status, 201); assert.equal(made.data.id, 'p1');
    assert.equal((await h.call('PATCH', '/api/panels/p1', { x: 10, y: 20, minimized: true })).data.x, 10);
    assert.equal((await h.call('POST', '/api/panels', { type: 'image', props: {} })).status, 400);
    assert.equal((await h.call('POST', '/api/panels', { type: 'progress' })).data.id, 'progress');
    assert.equal((await h.call('POST', '/api/panels', { type: 'progress' })).data.id, 'progress', 'singleton');
    assert.equal((await h.call('DELETE', '/api/panels/p1')).status, 200);
    assert.equal((await h.call('DELETE', '/api/panels/p1')).status, 404);
    const ev = await events;
    assert.equal(ev[0].event, 'snapshot');
    assert.deepEqual(ev.filter((e) => e.event === 'panel').map((e) => JSON.parse(e.data).action).slice(0, 2), ['created', 'updated']);
    // a fresh subscriber sees the current state
    const snap = await readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.length > 0);
    assert.equal(JSON.parse(snap[0].data).panels.length, 1);
  } finally { await h.close(); }
});

test('malformed panel file on disk: warning event, server keeps going', async () => {
  const h = await startHatch();
  try {
    fs.writeFileSync(path.join(h.stateDir, 'panels', 'p9.json'), '{{{');
    h.hatch.state.rescan();
    const snap = await readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.length > 0);
    assert.match(JSON.parse(snap[0].data).warnings[0].message, /invalid JSON/);
    assert.equal((await h.call('GET', '/api/health')).status, 200);
  } finally { await h.close(); }
});

test('progress API and notify', async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('PUT', '/api/progress/diagram', 'flowchart LR\n  a --> b\n', { 'content-type': 'text/plain' })).status, 200);
    assert.equal((await h.call('PUT', '/api/progress/steps', [{ id: 'a', title: 'A', status: 'todo' }])).status, 200);
    assert.equal((await h.call('PATCH', '/api/progress/steps/a', { status: 'done' })).status, 200);
    const p = (await h.call('GET', '/api/progress')).data;
    assert.equal(p.steps[0].status, 'done'); assert.match(p.diagram, /class a done/);
    assert.equal((await h.call('PUT', '/api/progress/steps', { nope: 1 })).status, 400);
    assert.equal((await h.call('POST', '/api/notify', { level: 'done' })).status, 400);
    const got = readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'notify'));
    await new Promise((r) => setTimeout(r, 200));
    await h.call('POST', '/api/notify', { text: 'finished', level: 'done' });
    assert.match((await got).find((x) => x.event === 'notify').data, /finished/);
  } finally { await h.close(); }
});

test('widgets: PUT writes files, served with CSP, sources stream by name, reload bumps the revision', async () => {
  const h = await startHatch();
  try {
    const put = await h.call('PUT', '/api/widgets/echo', { files: { 'index.html': '<p>hi</p>' }, meta: { title: 'Echo', sources: [{ name: 'now', kind: 'exec', cmd: 'echo 42', everyMs: 500 }] } });
    assert.equal(put.status, 200);
    assert.equal((await h.call('PUT', '/api/widgets/echo', { files: { '../evil.html': 'x', 'index.html': 'y' } })).status, 400);
    const page = await fetch(`${h.base}/widgets/echo/index.html`);
    assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.equal((await fetch(`${h.base}/widgets/echo/..%2f..%2fconfig.json`)).status, 404);
    assert.equal((await fetch(`${h.base}/sdk.js`)).status, 200);
    const list = (await h.call('GET', '/api/widgets')).data; assert.equal(list[0].title, 'Echo');
    const s = await readSse(`${h.base}/api/source/echo/now`, { 'x-token': h.hatch.token }, (e) => e.length > 0);
    assert.equal(JSON.parse(s[0].data).value.out, '42');
    assert.equal((await h.call('GET', '/api/source/echo/other')).status, 404);
    const panel = await h.call('POST', '/api/panels', { type: 'widget', props: { name: 'echo' } });
    assert.equal(panel.data.title, 'Echo'); assert.equal(panel.data.id, 'w-echo');
    assert.equal((await h.call('POST', '/api/widgets/echo/reload', {})).status, 200);
    assert.equal((await h.call('DELETE', '/api/widgets/echo')).status, 200);
    await waitFor(async () => (await h.call('GET', '/api/panels')).data.length === 0);
  } finally { await h.close(); }
});

test('real tmux: session is created, survives the pty, and gets HATCH_* env', { skip: !(hasTmux && hasPython) }, async () => {
  const name = `hatchtest${process.pid}`;
  const h = await startHatch({ session: name, attach: null });
  try {
    h.hatch.term.setEnv({ HATCH_STATE: h.stateDir });
    assert.equal((await h.call('GET', '/api/term')).data.running, true);
    assert.doesNotThrow(() => h.hatch.term.tmux(['has-session', '-t', `=${name}`]));
    await h.call('POST', '/api/term/input', { data: 'echo S=$HATCH_STATE\n' });
    await waitFor(() => h.hatch.term.replay().toString().includes(`S=${h.stateDir}`), 5000);
    await h.call('POST', '/api/term/input', { data: 'echo KEEP > /dev/null\n' });
  } finally {
    await h.close();
    try { h.hatch.term.tmux(['has-session', '-t', `=${name}`]); h.hatch.term.tmux(['kill-session', '-t', name]); } catch { /* already gone */ }
  }
});

test('widget sources are multiplexed over /api/events: subscribe by POST, data arrives as source events, ends with the client', async () => {
  const h = await startHatch();
  try {
    await h.call('PUT', '/api/widgets/m', { files: { 'index.html': 'x' }, meta: { sources: [{ name: 'now', kind: 'exec', cmd: 'echo 7', everyMs: 500 }] } });
    const got = readSse(`${h.base}/api/events?cid=c1`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'source'), 5000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await h.call('POST', '/api/sub', { cid: 'c1', widget: 'm', source: 'now' })).status, 200);
    assert.equal((await h.call('POST', '/api/sub', { cid: 'c1', widget: 'm', source: 'nope' })).status, 404);
    assert.equal((await h.call('POST', '/api/sub', { widget: 'm' })).status, 400);
    const ev = (await got).find((x) => x.event === 'source'); assert.equal(JSON.parse(ev.data).value.out, '7');
    await waitFor(() => h.hatch.sources.active() === 0, 4000); // the stream closed: its sampler stopped
  } finally { await h.close(); }
});

test('terminal windows: each name is its own pty; input and stream are separate; kill removes it', { skip: !hasPython }, async () => {
  const h = await startHatch();
  try {
    assert.equal((await h.call('POST', '/api/pterm/one', {})).data.running, true);
    assert.equal((await h.call('POST', '/api/pterm/two', {})).data.running, true);
    assert.equal((await h.call('POST', '/api/pterm/bad name', {})).status, 404);
    const one = readSse(`${h.base}/api/pterm/one/stream`, { 'x-token': h.hatch.token }, (ev) => ev.some((e) => Buffer.from(e.data, 'base64').toString().includes('only-in-one')));
    await new Promise((r) => setTimeout(r, 300));
    await h.call('POST', '/api/pterm/one/input', { data: 'only-in-one\n' }); await h.call('POST', '/api/pterm/two/input', { data: 'only-in-two\n' });
    const text = (await one).map((e) => Buffer.from(e.data, 'base64').toString()).join('');
    assert.ok(text.includes('only-in-one') && !text.includes('only-in-two'));
    assert.equal((await h.call('POST', '/api/pterm/one/resize', { cols: 50, rows: 20 })).data.cols, 50);
    assert.equal((await h.call('POST', '/api/panels', { type: 'terminal', props: { name: 'one' } })).data.id, 't-one');
    assert.equal((await h.call('POST', '/api/panels', { type: 'terminal', props: { name: 'x y' } })).status, 400);
    assert.equal((await h.call('DELETE', '/api/pterm/one')).status, 200);
  } finally { await h.close(); }
});

test('real tmux: a terminal window with a command runs without a tmux session', { skip: !(hasTmux && hasPython) }, async () => {
  const base = `hatchwt${process.pid}`;
  const h = await startHatch({ session: base, attach: null });
  try {
    await h.call('POST', '/api/pterm/job', { cmd: 'echo started-by-cmd; sleep 20' });
    assert.equal((await h.call('GET', '/api/pterm/job/alive')).data.alive, true);
    assert.throws(() => h.hatch.term.tmux(['has-session', '-t', `=${base}-job`])); // no helper session for the window
    await h.call('DELETE', '/api/pterm/job');
    assert.equal((await h.call('GET', '/api/pterm/job/alive')).data.alive, false);
  } finally { await h.close(); for (const n of [base, `${base}-job`]) { try { h.hatch.term.tmux(['kill-session', '-t', n]); } catch { /* gone */ } } }
});

test('progress history: listed, readable, path traversal refused', async () => {
  const h = await startHatch();
  try {
    assert.deepEqual((await h.call('GET', '/api/progress/history')).data, []);
    await h.call('PUT', '/api/progress/diagram', 'flowchart LR\n a --> b\n', { 'content-type': 'text/plain' });
    await h.call('PUT', '/api/progress/diagram', 'flowchart LR\n a --> c\n', { 'content-type': 'text/plain' });
    const list = (await h.call('GET', '/api/progress/history')).data; assert.equal(list.length, 1);
    assert.match((await h.call('GET', `/api/progress/history/${list[0]}`)).data, /a --> b/);
    assert.equal((await h.call('GET', '/api/progress/history/nope.mmd')).status, 404);
    assert.equal((await h.call('GET', '/api/progress/history/..%2Fdiagram.mmd')).status, 404);
  } finally { await h.close(); }
});

test('review fixes: unreadable file does not crash the server, null bodies are 400 not 500, one dropped events stream keeps the other subscriptions', async () => {
  const fsm = await import('node:fs'); const pth = await import('node:path');
  const h = await startHatch();
  try {
    const secret = pth.join(h.dir, 'locked.txt'); fsm.writeFileSync(secret, 'x'); fsm.chmodSync(secret, 0o000);
    if (process.getuid?.() !== 0) {
      assert.equal((await h.call('GET', `/api/fs/download?path=${encodeURIComponent(secret)}`)).status, 403);
      assert.equal((await h.call('GET', '/api/health')).status, 200, 'server still alive');
    }
    assert.equal((await fetch(`${h.base}/api/term/input`, { method: 'POST', headers: { 'x-token': h.hatch.token, 'content-type': 'application/json' }, body: 'null' })).status, 400);
    assert.equal((await h.call('POST', '/api/sub', { cid: 'c9', widget: 'x', source: 'y' })).status, 404);
    // two streams with one cid: closing the first must not drop what the second subscribed
    await h.call('PUT', '/api/widgets/m2', { files: { 'index.html': 'x' }, meta: { sources: [{ name: 's', kind: 'exec', cmd: 'echo 1', everyMs: 500 }] } });
    const a = new AbortController(); const b2 = new AbortController();
    const ra = await fetch(`${h.base}/api/events?cid=dup`, { headers: { 'x-token': h.hatch.token }, signal: a.signal }); void ra;
    const rb = await fetch(`${h.base}/api/events?cid=dup`, { headers: { 'x-token': h.hatch.token }, signal: b2.signal }); void rb;
    await h.call('POST', '/api/sub', { cid: 'dup', widget: 'm2', source: 's' });
    a.abort(); await new Promise((r) => setTimeout(r, 400));
    assert.equal(h.hatch.sources.active(), 1, 'subscription survives the first stream closing');
    b2.abort(); await waitFor(() => h.hatch.sources.active() === 0, 3000);
    fsm.chmodSync(secret, 0o600);
  } finally { await h.close(); }
});

test('review fixes: idle watches fire independently; run ids differ after a restart', async () => {
  const fsm = await import('node:fs'); const pth = await import('node:path'); const { createWatches } = await import('../src/watches.js'); const { createRuns } = await import('../src/runs.js'); const { tmp } = await import('./helpers.js');
  const file = pth.join(tmp(), 'w.json'); fsm.writeFileSync(file, JSON.stringify([{ name: 'short', idleSec: 5, cooldownSec: 1 }, { name: 'long', idleSec: 60, cooldownSec: 1 }]));
  let t = 0; const got = []; const w = createWatches({ file, notify: (n) => got.push(n.text), now: () => t, tickMs: 1e9 });
  t = 1000; w.feed(Buffer.from('x')); t += 6000; w.tick(); t += 60000; w.tick();
  assert.equal(got.length, 2); assert.match(got[0], /short/); assert.match(got[1], /long/); w.close();
  const r1 = createRuns({ cwd: process.cwd() }); const a = r1.start('true').id; await new Promise((r) => setTimeout(r, 5)); const r2 = createRuns({ cwd: process.cwd() }); const b = r2.start('true').id;
  assert.notEqual(a, b);
});

test('custom.css / custom.js are served from the state dir when present, 404 otherwise, and need the token', async () => {
  const fsm = await import('node:fs'); const pth = await import('node:path');
  const h = await startHatch();
  try {
    assert.equal((await h.call('GET', '/custom/custom.js')).status, 404);
    fsm.writeFileSync(pth.join(h.stateDir, 'custom.js'), 'window.__c = 1;'); fsm.writeFileSync(pth.join(h.stateDir, 'custom.css'), ':root{--accent:red}');
    const js = await fetch(`${h.base}/custom/custom.js`, { headers: { 'x-token': h.hatch.token } }); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/); assert.equal(await js.text(), 'window.__c = 1;');
    assert.match((await fetch(`${h.base}/custom/custom.css`, { headers: { 'x-token': h.hatch.token } })).headers.get('content-type'), /css/);
    assert.equal((await fetch(`${h.base}/custom/custom.js`)).status, 401);
    assert.equal((await h.call('GET', '/custom/other.js')).status, 404, 'only the two known names');
    assert.equal((await h.call('GET', '/custom/..%2fconfig.json')).status, 404);
  } finally { await h.close(); }
});

test('exec placeholders {{session}} {{state}} {{cwd}} are expanded and shell-quoted', async () => {
  const h = await startHatch({ session: "se'ss" });
  try {
    await h.call('PUT', '/api/widgets/ph', { files: { 'index.html': 'x' }, meta: { sources: [{ name: 'p', kind: 'exec', cmd: 'echo {{session}}; echo {{state}}; echo {{cwd}}', everyMs: 500 }] } });
    const s = await readSse(`${h.base}/api/source/ph/p`, { 'x-token': h.hatch.token }, (e) => e.length > 0);
    const out = JSON.parse(s[0].data).value.out.split('\n'); assert.equal(out[0], "se'ss"); assert.equal(out[1], h.stateDir); assert.equal(out[2], h.dir);
  } finally { await h.close(); }
});

test('client errors are logged to the server log and rate limited', async () => {
  const fsm = await import('node:fs'); const pth = await import('node:path');
  const h = await startHatch();
  try {
    for (let i = 0; i < 40; i++) assert.equal((await h.call('POST', '/api/clientlog', { message: `boom ${i}`, source: 'app.js', line: 7, agent: 'test' })).status, 200);
    assert.equal((await h.call('POST', '/api/clientlog', null)).status, 200, 'a null body is tolerated');
    const text = fsm.readFileSync(pth.join(h.stateDir, 'log', 'server.log'), 'utf8');
    assert.match(text, /client error: boom 0 at app\.js:7/); assert.equal((text.match(/client error: boom/g) || []).length, 30, 'only 30 per minute are kept');
    assert.equal((await fetch(`${h.base}/api/clientlog`, { method: 'POST', body: '{}' })).status, 401, 'needs the token');
  } finally { await h.close(); }
});

test('view-only: watching works, anything that changes or reads the box is 403', { skip: !hasPython }, async () => {
  const h = await startHatch({ viewOnly: true });
  try {
    for (const [m, r, body] of [['GET', '/api/health'], ['GET', '/api/info'], ['GET', '/api/panels'], ['GET', '/api/progress'], ['GET', '/api/term'], ['GET', '/api/widgets'], ['POST', '/api/clientlog', {}]]) assert.equal((await h.call(m, r, body)).status, 200, `${m} ${r} allowed`);
    assert.equal((await fetch(`${h.base}/`, { headers: { 'x-token': h.hatch.token } })).status, 200, 'the page itself loads');
    for (const [m, r, body] of [['POST', '/api/term/input', { data: 'rm -rf x\n' }], ['POST', '/api/term/resize', { cols: 80, rows: 24 }], ['POST', '/api/panels', { type: 'note', props: { markdown: 'x' } }], ['POST', '/api/runs', { cmd: 'id' }], ['GET', '/api/fs/read?path=/etc/hostname'], ['GET', '/api/fs/list?path=/'], ['PUT', '/api/fs/write', { path: '/tmp/x', text: '' }], ['POST', '/api/notify', { text: 'x' }], ['GET', '/api/runs'], ['GET', '/api/git/status'], ['GET', '/api/file?path=/x.png'], ['GET', '/proxy/80/'], ['POST', '/api/term/windows/new', {}], ['GET', '/api/report'], ['GET', '/api/ports'], ['PUT', '/api/commands', []], ['POST', '/api/upload', 'x']]) assert.equal((await h.call(m, r, body)).status, 403, `${m} ${r} refused`);
    assert.equal((await h.call('GET', '/api/info')).data.viewOnly, true);
  } finally { await h.close(); }
});

test('view token: a second token that only gets the view-only subset; cookie login; revoke; same instance', { skip: !hasPython }, async () => {
  const fsm = await import('node:fs'); const pth = await import('node:path'); const { spawnSync } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const h = await startHatch(); const HATCH = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));
  try {
    const url = spawnSync('node', [HATCH, 'url', '--view', '--state', h.stateDir], { encoding: 'utf8' }).stdout; const vt = /\?t=(\w+)/.exec(url)[1];
    assert.notEqual(vt, h.hatch.token); assert.match(url, /Watch-only/);
    assert.equal(spawnSync('node', [HATCH, 'url', '--view', '--state', h.stateDir], { encoding: 'utf8' }).stdout.includes(vt), true, 'the same view token is shown again');
    const view = (m, r, b) => fetch(h.base + r, { method: m, headers: { 'x-token': vt, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    assert.equal((await view('GET', '/api/panels')).status, 200); assert.equal((await view('GET', '/api/info').then((r) => r.json())).viewOnly, true);
    for (const [m, r, b] of [['POST', '/api/term/input', { data: 'x' }], ['POST', '/api/runs', { cmd: 'id' }], ['GET', '/api/fs/list?path=/'], ['POST', '/api/panels', { type: 'note', props: { markdown: 'x' } }]]) assert.equal((await view(m, r, b)).status, 403, `${m} ${r}`);
    assert.equal((await h.call('GET', '/api/info')).data.viewOnly, false, 'the full token is unaffected');
    const login = await fetch(`${h.base}/?t=${vt}`, { redirect: 'manual' }); assert.equal(login.status, 302); assert.match(login.headers.get('set-cookie'), new RegExp(vt));
    const snap = await readSse(`${h.base}/api/events`, { cookie: `hatch_token=${vt}` }, (e) => e.length > 0); assert.equal(JSON.parse(snap[0].data).info.viewOnly, true, 'the page learns it is a viewer');
    assert.equal((await fetch(`${h.base}/api/health`, { headers: { 'x-token': 'x'.repeat(32) } })).status, 401);
    spawnSync('node', [HATCH, 'url', '--revoke-view', '--state', h.stateDir]); assert.equal((await view('GET', '/api/panels')).status, 401, 'a revoked view token stops working at once');
  } finally { await h.close(); }
});

test('web app manifest and icon are served (with the token) and the page links them', async () => {
  const h = await startHatch();
  try {
    const m = await fetch(`${h.base}/manifest.webmanifest`, { headers: { 'x-token': h.hatch.token } }); assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /manifest\+json/);
    const j = await m.json(); assert.equal(j.display, 'standalone'); assert.equal(j.start_url, '/');
    const icon = await fetch(`${h.base}/icon.svg`, { headers: { 'x-token': h.hatch.token } }); assert.equal(icon.status, 200); assert.match(icon.headers.get('content-type'), /svg/); assert.match(await icon.text(), /<svg/);
    assert.match(await (await fetch(`${h.base}/`, { headers: { 'x-token': h.hatch.token } })).text(), /rel="manifest"/);
  } finally { await h.close(); }
});

test('the page is served with a Content-Security-Policy, framing protection and no referrer; static scripts and widget files are not given the page policy', async () => {
  const h = await startHatch();
  try {
    const page = await fetch(`${h.base}/`, { headers: { 'x-token': h.hatch.token } });
    const csp = page.headers.get('content-security-policy'); assert.match(csp, /script-src 'self'(;|$)/); assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/); assert.match(csp, /frame-ancestors 'self'/); assert.match(csp, /object-src 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN'); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const js = await fetch(`${h.base}/app.js`, { headers: { 'x-token': h.hatch.token } }); assert.equal(js.headers.get('content-security-policy'), null);
    await h.call('PUT', '/api/widgets/w', { files: { 'index.html': '<p>x</p>' } });
    assert.match((await fetch(`${h.base}/widgets/w/index.html`)).headers.get('content-security-policy'), /sandbox allow-scripts/, 'widgets keep their own, stricter policy');
  } finally { await h.close(); }
});

test('failed logins are logged with the address, rate limited, and the token never appears in the log', async () => {
  const fsm = await import('node:fs'); const pth = await import('node:path');
  const h = await startHatch();
  try {
    for (let i = 0; i < 15; i++) await fetch(`${h.base}/api/health`, { headers: { 'x-token': 'wrong-wrong-wrong-wrong' } });
    await fetch(`${h.base}/?t=not-the-token-at-all-nope`);
    const text = fsm.readFileSync(pth.join(h.stateDir, 'log', 'server.log'), 'utf8');
    const lines = text.split('\n').filter((l) => l.includes('auth failed')); assert.equal(lines.length, 10, 'rate limited to 10 per minute'); assert.match(lines[0], /auth failed: GET \/api\/health from 127\.0\.0\.1/);
    assert.doesNotMatch(text, new RegExp(h.hatch.token), 'the real token is never logged'); assert.doesNotMatch(text, /wrong-wrong|not-the-token/, 'attempted tokens are not logged either');
  } finally { await h.close(); }
});

test('widget files: a symlink pointing outside the widget folder is not served (these files need no token)', async () => {
  const fsm = await import('node:fs'); const pth = await import('node:path');
  const h = await startHatch();
  try {
    await h.call('PUT', '/api/widgets/sl', { files: { 'index.html': '<p>ok</p>', 'inner.txt': 'inside' } });
    const secret = pth.join(h.dir, 'secret.txt'); fsm.writeFileSync(secret, 'TOP-SECRET');
    fsm.symlinkSync(secret, pth.join(h.stateDir, 'widgets', 'sl', 'leak.txt')); fsm.symlinkSync('inner.txt', pth.join(h.stateDir, 'widgets', 'sl', 'ok-link.txt')); fsm.symlinkSync(h.dir, pth.join(h.stateDir, 'widgets', 'sl', 'dirlink'));
    assert.equal((await fetch(`${h.base}/widgets/sl/leak.txt`)).status, 404); assert.equal((await fetch(`${h.base}/widgets/sl/dirlink/secret.txt`)).status, 404);
    assert.equal(await (await fetch(`${h.base}/widgets/sl/ok-link.txt`)).text(), 'inside', 'a link that stays inside the widget folder still works');
    assert.equal(await (await fetch(`${h.base}/widgets/sl/index.html`)).text(), '<p>ok</p>');
  } finally { await h.close(); }
});

test('--tmux-status mirrors the running progress step into this session\'s status line and clears it again', { skip: !(hasTmux && hasPython) }, async () => {
  const name = `hatchst${process.pid}`;
  const h = await startHatch({ session: name, attach: null, tmuxStatus: true });
  const show = () => { try { return h.hatch.term.tmux(['show-options', '-t', name, 'status-right']); } catch { return ''; } };
  try {
    await h.call('GET', '/api/term'); // creates the tmux session
    await h.call('PUT', '/api/progress/steps', [{ id: 'a', title: 'plan', status: 'done' }, { id: 'b', title: 'build #1 %x', status: 'running' }, { id: 'c', title: 'ship', status: 'todo' }]);
    await waitFor(() => /now: build/.test(show()), 4000); assert.match(show(), /now: build  1  x \(1\/3\)/, 'sanitised title with done/total');
    await h.call('PATCH', '/api/progress/steps/b', { status: 'done' }); await waitFor(() => !/now:/.test(show()), 4000);
    // without the flag nothing is touched
    const plain = await startHatch({ session: `${name}p`, attach: null }); try { await plain.call('GET', '/api/term'); await plain.call('PUT', '/api/progress/steps', [{ id: 'a', title: 'x', status: 'running' }]); await new Promise((r) => setTimeout(r, 400)); assert.doesNotMatch((() => { try { return plain.hatch.term.tmux(['show-options', '-t', `${name}p`, 'status-right']); } catch { return ''; } })(), /now:/); } finally { await plain.close(); try { plain.hatch.term.tmux(['kill-session', '-t', `${name}p`]); } catch { /* gone */ } }
  } finally { await h.close(); try { h.hatch.term.tmux(['kill-session', '-t', name]); } catch { /* gone */ } }
});

test('view links can watch existing run and extra-terminal streams without gaining file or command access', { skip: !hasPython }, async () => {
  const h = await startHatch();
  try {
    const file = path.join(h.stateDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')); config.viewToken = 'viewer-token-for-stream-check'; fs.writeFileSync(file, JSON.stringify(config));
    const headers = { 'x-token': config.viewToken };
    const run = (await h.call('POST', '/api/runs', { cmd: 'printf viewer-output' })).data;
    const events = await readSse(`${h.base}/api/runs/${run.id}/stream`, headers, list => list.some(event => event.event === 'exit'));
    assert.match(events.filter(event => event.event !== 'exit').map(event => Buffer.from(event.data, 'base64').toString()).join(''), /viewer-output/);
    assert.equal((await fetch(`${h.base}/api/runs`, { headers })).status, 403);
    assert.equal((await fetch(`${h.base}/api/fs/list?path=/`, { headers })).status, 403);
    assert.equal((await fetch(`${h.base}/api/runs/${run.id}`, { method: 'DELETE', headers })).status, 403);
    assert.equal((await fetch(`${h.base}/api/runs`, { method: 'POST', headers, body: '{"cmd":"true"}' })).status, 403);
    assert.equal((await fetch(`${h.base}/api/term`, { headers }).then(response => response.json())).viewOnly, true);
    assert.equal((await fetch(`${h.base}/api/pterm/not-created/stream`, { headers })).status, 404, 'a viewer cannot create an arbitrary named terminal');
    await h.call('POST', '/api/pterm/watchtest', {});
    await h.call('POST', '/api/pterm/watchtest/input', { data: 'extra-view-output\n' });
    const extra = await readSse(`${h.base}/api/pterm/watchtest/stream`, headers, list => list.some(event => ['message', 'replay'].includes(event.event)));
    assert.ok(extra.some(event => ['message', 'replay'].includes(event.event)));
    assert.equal((await fetch(`${h.base}/api/pterm/watchtest`, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(`${h.base}/api/pterm/watchtest/input`, { method: 'POST', headers, body: '{"data":"x"}' })).status, 403);
  } finally { await h.close(); }
});

test('revoking a view token closes run and extra-terminal watch streams', { skip: !hasPython }, async () => {
  const h = await startHatch(); const controller = new AbortController(); let deadline;
  try {
    const file = path.join(h.stateDir, 'config.json'); const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.viewToken = 'viewer-token-for-revoke-check'; fs.writeFileSync(file, JSON.stringify(config));
    const run = (await h.call('POST', '/api/runs', { cmd: 'sleep 30' })).data;
    await h.call('POST', '/api/pterm/revoketest', {});
    const routes = [`/api/runs/${run.id}/stream`, '/api/pterm/revoketest/stream'];
    const streams = await Promise.all(routes.map(route => fetch(h.base + route, { headers: { 'x-token': config.viewToken }, signal: controller.signal })));
    assert.ok(streams.every(response => response.status === 200));
    deadline = setTimeout(() => controller.abort(), 7000);
    const endings = streams.map(async response => {
      try { for await (const chunk of response.body) { /* drain until revocation closes the stream */ } }
      catch (error) { if (controller.signal.aborted) throw error; }
    });
    delete config.viewToken; fs.writeFileSync(file, JSON.stringify(config));
    await Promise.all(endings); assert.equal(controller.signal.aborted, false);
    assert.equal((await h.call('GET', '/api/health')).status, 200, 'owner access remains usable');
  } finally { clearTimeout(deadline); controller.abort(); await h.close(); }
});

test('trash panel: opens, and the API it uses lists newest first and restores', async () => {
  const t = await startHatch();
  try {
    const win = await t.call('POST', '/api/panels', { type: 'trash', title: 'Trash' });
    assert.equal(win.status, 201, JSON.stringify(win.data));
    const a = (await t.call('POST', '/api/panels', { type: 'note', title: 'first', props: { markdown: 'a' } })).data;
    const b = (await t.call('POST', '/api/panels', { type: 'note', title: 'second', props: { markdown: 'b' } })).data;
    assert.equal((await t.call('GET', '/api/trash')).data.length, 0);
    await t.call('DELETE', `/api/panels/${a.id}`);
    await new Promise((r) => setTimeout(r, 1100)); // trash file names have second-or-better resolution; keep order unambiguous
    await t.call('DELETE', `/api/panels/${b.id}`);
    const list = (await t.call('GET', '/api/trash')).data;
    assert.deepEqual(list.map((e) => e.title), ['second', 'first']);
    assert.ok(list[0].type && list[0].closed && list[0].trashId);
    const back = await t.call('POST', '/api/trash/restore', { trashId: list[1].trashId });
    assert.equal(back.status, 200);
    assert.equal(back.data.title, 'first');
    assert.deepEqual((await t.call('GET', '/api/trash')).data.map((e) => e.title), ['second']);
  } finally { await t.close(); }
});
