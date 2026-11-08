import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuns } from '../src/runs.js';
import { startHatch, readSse, waitFor } from './helpers.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a run captures stdout and stderr, reports the exit code and notifies', async () => {
  const notes = []; const runs = createRuns({ cwd: process.cwd(), notify: (n) => notes.push(n) });
  const r = runs.start('echo out; echo err >&2; exit 3');
  await waitFor(() => runs.get(r.id).state === 'done');
  assert.equal(runs.get(r.id).code, 3); assert.equal(notes[0].level, 'warn'); assert.match(notes[0].text, /exit 3/);
  const ok = runs.start('true'); await waitFor(() => runs.get(ok.id).state === 'done'); assert.equal(notes[1].level, 'done');
  assert.throws(() => runs.start('  '), /needs a command/); assert.throws(() => runs.get('r99'), /no run/);
});

test('run API: stream replays output then exit; stop kills the process group', async () => {
  const h = await startHatch();
  try {
    const made = (await h.call('POST', '/api/runs', { cmd: 'echo hello-run' })).data;
    const ev = await readSse(`${h.base}/api/runs/${made.id}/stream`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'exit'));
    const text = ev.filter((e) => e.event === 'replay' || e.event === 'message').map((e) => Buffer.from(e.data, 'base64').toString()).join('');
    assert.match(text, /hello-run/); assert.equal(ev.find((e) => e.event === 'exit').data, '0');
    const long = (await h.call('POST', '/api/runs', { cmd: 'sleep 30 & wait' })).data;
    assert.equal((await h.call('GET', `/api/runs/${long.id}`)).data.state, 'running');
    await h.call('DELETE', `/api/runs/${long.id}`);
    await waitFor(async () => (await h.call('GET', `/api/runs/${long.id}`)).data.state === 'done');
    assert.equal((await h.call('GET', '/api/runs/r99')).status, 404);
    assert.equal((await h.call('POST', '/api/runs', {})).status, 400);
    assert.equal((await h.call('POST', '/api/panels', { type: 'output', props: { cmd: 'ls', runId: made.id } })).status, 201);
    assert.equal((await h.call('POST', '/api/panels', { type: 'output', props: {} })).status, 400);
  } finally { await h.close(); }
});

test('hatch run --wait exits with the command exit code', async () => {
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url)); const HATCH = fileURLToPath(new URL('../bin/ui.js', import.meta.url));
  const run = (cmd, wait = true, entry = UI) => new Promise((res) => { const p = spawn('node', [entry, '--state', h.stateDir, 'run', cmd, ...(wait ? ['--wait'] : [])]); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out })); });
  try {
    assert.equal((await run('exit 0')).code, 0);
    const bad = await run('exit 4'); assert.equal(bad.code, 4); assert.match(bad.out, /exit 4/);
    for (const [command, code] of [['hatch_missing_command_for_exit_status_test', 127], ['kill -TERM $$', 143], ['exit 255', 255]]) {
      const result = await run(command); assert.equal(result.code, code, command); assert.match(result.out, new RegExp(`exit ${code}`));
    }
    assert.equal((await run('exit 7', false)).code, 0, 'without --wait the CLI reports successful submission');
    assert.equal((await run('exit 9', true, HATCH)).code, 9, 'the deprecated hatch-ui alias preserves the same status');
    assert.equal((await h.call('GET', '/api/panels')).data.filter((p) => p.type === 'output').length, 7);
  } finally { await h.close(); }
});

test('hatch grep and diff open output windows whose commands produce path:line results and a diff', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const { tmp } = await import('./helpers.js');
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const cli = (args, cwd) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args], { cwd }); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out })); });
  const repo = tmp();
  try {
    fs.writeFileSync(path.join(repo, 'a.js'), "const needle = 1;\nconst other = 2;\n");
    assert.equal((await cli(['grep', 'needle', repo], repo)).code, 0);
    await waitFor(async () => (await h.call('GET', '/api/runs')).data.every((r) => r.state === 'done') && (await h.call('GET', '/api/runs')).data.length === 1);
    const grepPanel = (await h.call('GET', '/api/panels')).data.find((p) => p.title.startsWith('grep'));
    const ev = await readSse(`${h.base}/api/runs/${grepPanel.props.runId}/stream`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'exit'));
    assert.match(ev.filter((e) => e.event !== 'exit').map((e) => Buffer.from(e.data, 'base64').toString()).join(''), /a\.js:1:.*needle/);
    const { spawnSync } = await import('node:child_process');
    spawnSync('git', ['init', '-q'], { cwd: repo }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: repo });
    fs.appendFileSync(path.join(repo, 'a.js'), 'added line\n');
    assert.equal((await cli(['diff'], repo)).code, 0);
    const dp = (await h.call('GET', '/api/panels')).data.find((p) => p.props.kind === 'diff');
    const dv = await readSse(`${h.base}/api/runs/${dp.props.runId}/stream`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'exit'));
    assert.match(dv.filter((e) => e.event !== 'exit').map((e) => Buffer.from(e.data, 'base64').toString()).join(''), /\+added line/);
  } finally { await h.close(); }
});

test('hatch man, tail and log open output windows with real output', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const { tmp } = await import('./helpers.js'); const { spawnSync } = await import('node:child_process');
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const cli = (args, cwd) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args], { cwd }); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out })); });
  const outputOf = async (title) => { const pn = (await h.call('GET', '/api/panels')).data.find((p) => p.title.startsWith(title)); await waitFor(async () => (await h.call('GET', `/api/runs/${pn.props.runId}`)).data.state === 'done' || title === 'tail'); const ev = await readSse(`${h.base}/api/runs/${pn.props.runId}/stream`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'exit' || title === 'tail'), 2500); return { pn, text: ev.filter((e) => e.event !== 'exit').map((e) => Buffer.from(e.data, 'base64').toString()).join('') }; };
  const repo = tmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: repo }); fs.writeFileSync(path.join(repo, 'f'), 'x'); spawnSync('git', ['add', '.'], { cwd: repo }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first commit message'], { cwd: repo });
    assert.equal((await cli(['log', '--oneline', '-5'], repo)).code, 0); assert.match((await outputOf('git log')).text, /first commit message/);
    const f = path.join(repo, 'app.log'); fs.writeFileSync(f, 'line-a\n');
    assert.equal((await cli(['tail', f], repo)).code, 0); const t = await outputOf('tail'); assert.match(t.text, /line-a/);
    await h.call('DELETE', `/api/runs/${t.pn.props.runId}`); // tail -F never ends by itself
    assert.equal((await cli(['tail', path.join(repo, 'nope')], repo)).code, 1);
    assert.equal((await cli(['man'], repo)).code, 1);
  } finally { await h.close(); }
});

test('report: markdown with progress, runs and windows; --out writes a file', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const cli = (args) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args]); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out })); });
  try {
    await cli(['progress', 'step', 'write tests', 'running']); await cli(['run', 'exit 3', '--wait']); await cli(['note', 'x', '--title', 'My note']);
    const r = await cli(['report']); assert.equal(r.code, 0);
    assert.match(r.out, /# Hatch session report/); assert.match(r.out, /\[~\] write tests \(running\)/); assert.match(r.out, /`exit 3`: exit 3/); assert.match(r.out, /note: My note/);
    const out = path.join(h.dir, 'r.md'); assert.equal((await cli(['report', '--out', out])).code, 0); assert.match(fs.readFileSync(out, 'utf8'), /## Runs/);
    assert.equal((await cli(['report', '--open'])).code, 0);
    assert.ok((await h.call('GET', '/api/panels')).data.some((p) => p.title === 'Session report'));
  } finally { await h.close(); }
});

test('hatch curl shows status line, headers and body from a local server; needs arguments', async () => {
  const http = await import('node:http'); const { spawnSync } = await import('node:child_process');
  if (spawnSync('curl', ['--version']).status !== 0) return; // curl missing: nothing to test
  const up = http.createServer((req, res) => { res.writeHead(201, { 'x-demo': 'yes' }); res.end('curl-body-ok'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r)); const port = up.address().port;
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const cli = (args) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args]); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out })); });
  try {
    assert.equal((await cli(['curl'])).code, 1);
    assert.equal((await cli(['curl', '-H', 'x-test: 1', `http://127.0.0.1:${port}/`])).code, 0);
    const pn = (await h.call('GET', '/api/panels')).data.find((p) => p.title.startsWith('curl'));
    await waitFor(async () => (await h.call('GET', `/api/runs/${pn.props.runId}`)).data.state === 'done');
    const ev = await readSse(`${h.base}/api/runs/${pn.props.runId}/stream`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'exit'));
    const text = ev.filter((e) => e.event !== 'exit').map((e) => Buffer.from(e.data, 'base64').toString()).join('');
    assert.match(text, /HTTP\/1\.1 201/); assert.match(text, /x-demo: yes/i); assert.match(text, /curl-body-ok/);
  } finally { await h.close(); await new Promise((r) => up.close(r)); }
});

test('hatch runs lists runs and --open reattaches a window to a finished one', async () => {
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
  const cli = (args) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args]); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('close', (code) => res({ code, out })); });
  try {
    assert.match((await cli(['runs'])).out, /no runs/);
    await cli(['run', 'echo hist-one; exit 5', '--wait']);
    const list = await cli(['runs']); assert.match(list.out, /exit 5\s+echo hist-one/); const id = list.out.split(/\s+/)[0];
    assert.equal((await cli(['runs', '--open', id])).code, 0); assert.equal((await h.call('GET', '/api/panels')).data.filter((p) => p.type === 'output').length, 2);
    assert.equal((await cli(['runs', '--open', 'rzzz'])).code, 1);
  } finally { await h.close(); }
});

test('hatch serve-dir serves a folder through the proxy; edit FILE:LINE sets the line', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const { tmp } = await import('./helpers.js'); const { spawnSync } = await import('node:child_process');
  if (spawnSync('python3', ['-V']).status !== 0) return;
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url)); const d = tmp(); fs.writeFileSync(path.join(d, 'index.html'), '<h1>served-by-hatch</h1>'); fs.writeFileSync(path.join(d, 'f.txt'), 'a\nb\nc\n');
  const cli = (args) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args]); let out = ''; p.stdout.on('data', (x) => { out += x; }); p.stderr.on('data', (x) => { out += x; }); p.on('close', (code) => res({ code, out })); });
  try {
    const r = await cli(['serve-dir', d, '38' + String(Math.floor(Math.random() * 900) + 100)]); assert.equal(r.code, 0, r.out);
    const panel = (await h.call('GET', '/api/panels')).data.find((p) => p.type === 'iframe'); assert.match(panel.props.url, /^\/proxy\/\d+\/$/);
    await waitFor(async () => { const x = await fetch(`${h.base}${panel.props.url}`, { headers: { 'x-token': h.hatch.token } }); return (await x.text()).includes('served-by-hatch'); }, 6000);
    for (const run of (await h.call('GET', '/api/runs')).data) await h.call('DELETE', `/api/runs/${run.id}`);
    assert.equal((await cli(['edit', `${path.join(d, 'f.txt')}:3`])).code, 0);
    assert.equal((await h.call('GET', '/api/panels')).data.find((p) => p.type === 'editor').props.line, 3);
    assert.equal((await cli(['serve-dir', path.join(d, 'nope')])).code, 1);
  } finally { await h.close(); }
});

test('run output route returns plain text without ANSI, truncates from the front, and 404s for unknown runs', async () => {
  const h = await startHatch();
  try {
    const r = (await h.call('POST', '/api/runs', { cmd: "printf '\\033[31mred\\033[0m line\\n'; seq 1 4000" })).data; await waitFor(async () => (await h.call('GET', `/api/runs/${r.id}`)).data.state === 'done');
    const full = (await h.call('GET', `/api/runs/${r.id}/output`)).data; assert.match(full, /red line/); assert.doesNotMatch(full, /\u001b/);
    const tail = (await h.call('GET', `/api/runs/${r.id}/output?max=100`)).data; assert.match(tail, /truncated/); assert.match(tail, /4000\s*$/);
    assert.equal((await h.call('GET', '/api/runs/rnope/output')).status, 404);
  } finally { await h.close(); }
});

test('hatch diff-files compares two files; identical files and differing files are both fine', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const { tmp } = await import('./helpers.js');
  const h = await startHatch(); const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url)); const d = tmp();
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(d, 'b.txt'), 'one\n2\n'); fs.writeFileSync(path.join(d, 'c.txt'), 'one\ntwo\n');
  const cli = (args) => new Promise((res) => { const p = spawn('node', [UI, '--state', h.stateDir, ...args]); let out = ''; p.stdout.on('data', (x) => { out += x; }); p.stderr.on('data', (x) => { out += x; }); p.on('close', (code) => res({ code, out })); });
  try {
    assert.equal((await cli(['diff-files', path.join(d, 'a.txt'), path.join(d, 'b.txt')])).code, 0);
    const pn = (await h.call('GET', '/api/panels')).data.find((p) => p.props.kind === 'diff'); await waitFor(async () => (await h.call('GET', `/api/runs/${pn.props.runId}`)).data.state === 'done');
    const run = (await h.call('GET', `/api/runs/${pn.props.runId}`)).data; assert.equal(run.code, 0, 'diff exit 1 (files differ) is not a failure'); assert.match((await h.call('GET', `/api/runs/${pn.props.runId}/output`)).data, /-two\n\+2/);
    assert.equal((await cli(['diff-files', path.join(d, 'a.txt')])).code, 1); assert.equal((await cli(['diff-files', path.join(d, 'a.txt'), path.join(d, 'nope')])).code, 1);
    assert.equal((await cli(['diff-files', path.join(d, 'a.txt'), path.join(d, 'c.txt')])).code, 0);
  } finally { await h.close(); }
});

test('long command timeouts use safe timer segments and expire only at the requested deadline', (t) => {
  const max = 0x7fffffff; const timers = []; let time = 1700000000000; const completed = [];
  const runs = createRuns({ cwd: process.cwd() });
  t.mock.method(Date, 'now', () => time);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { timers.push({ callback, delay }); return { unref() {} }; });
  try {
    const run = runs.start('sleep 30', undefined, { quiet: true, timeoutSec: (max + 2000) / 1000, onDone: code => completed.push(code) });
    assert.equal(timers[0].delay, max); assert.equal(runs.get(run.id).state, 'running');
    time += max; timers[0].callback(); assert.equal(timers[1].delay, 2000); assert.deepEqual(completed, []);
    time += 2000; timers[1].callback(); assert.deepEqual(completed, [124]); assert.equal(runs.get(run.id).code, 124);
    for (const timeoutSec of [Infinity, NaN, -1, '10', 1e308]) assert.throws(() => runs.start('true', undefined, { timeoutSec }), e => e.status === 400);
  } finally { runs.stopAll(); }
});

test('Stop escalates for SIGTERM-ignoring groups and reports the actual killing signal', async () => {
  const runs = createRuns({ cwd: process.cwd(), stopGraceMs: 100 });
  try {
    const run = runs.start("trap '' TERM; printf ready; while :; do sleep 0.05; done", undefined, { quiet: true });
    await waitFor(() => runs.output(run.id).includes('ready'));
    assert.equal(runs.stop(run.id).stopping, true); assert.equal(runs.stop(run.id).stopping, true);
    await waitFor(() => runs.get(run.id).state === 'done', 5000);
    assert.equal(runs.get(run.id).code, 137); assert.equal(runs.get(run.id).signal, 'SIGKILL'); assert.equal(runs.get(run.id).stopping, false);
    assert.match(runs.output(run.id), /killed by SIGKILL/);
    assert.equal(runs.stop(run.id).code, 137, 'stopping a finished run is harmless');
  } finally { runs.close(); }
});

test('ordinary Stop reports SIGTERM conventionally and shutdown suppresses alerts and rejects new work', async () => {
  const notices = []; const runs = createRuns({ cwd: process.cwd(), notify: note => notices.push(note) });
  try {
    const run = runs.start('printf ready; sleep 30', undefined, { quiet: true }); await waitFor(() => runs.output(run.id).includes('ready'));
    runs.stop(run.id); await waitFor(() => runs.get(run.id).state === 'done');
    assert.equal(runs.get(run.id).code, 143); assert.equal(runs.get(run.id).signal, 'SIGTERM');
    const closing = runs.start('printf ready; sleep 30'); await waitFor(() => runs.output(closing.id).includes('ready'));
    runs.close(); runs.close(); await waitFor(() => runs.get(closing.id).state === 'done');
    assert.equal(runs.get(closing.id).code, 137); assert.deepEqual(notices, []);
    assert.throws(() => runs.start('true'), error => error.status === 503);
  } finally { runs.close(); }
});

test('run IDs stay distinct across managers started at the same clock value', async (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const first = createRuns({ cwd: process.cwd() }); const second = createRuns({ cwd: process.cwd() }); t.mock.restoreAll();
  try {
    const a = first.start('true', undefined, { quiet: true }); const b = second.start('true', undefined, { quiet: true });
    assert.notEqual(a.id, b.id); assert.match(a.id, /^r\w+$/); assert.match(b.id, /^r\w+$/);
    await waitFor(() => first.get(a.id).state === 'done' && second.get(b.id).state === 'done');
  } finally { first.close(); second.close(); }
});
