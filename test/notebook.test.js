// Notebook widget: the runner protocol (python3 only, no network) and the widget-process support it rides on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHatch } from '../src/server.js';
import { startHatch, readSse, sleep, waitFor, tmp } from './helpers.js';

const RUNNER = fileURLToPath(new URL('../examples/widgets/notebook/runner.py', import.meta.url));
const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasMpl = hasPython && spawnSync('python3', ['-c', 'import matplotlib']).status === 0;
const opts = { skip: hasPython ? false : 'python3 is not installed' };

/** A runner process with a line-based client; `until(pred)` waits for a message. */
function kernel(dir, env = {}) {
  const child = spawn('python3', ['-u', RUNNER, dir], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const msgs = []; const raw = []; const pieces = new Map(); let buf = '';
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); raw.push(m);
      if (m.t !== 'chunk') { msgs.push(m); continue; }
      const p = pieces.get(m.mid) || []; p[m.i] = m.d; pieces.set(m.mid, p); // join the pieces of a long line, as the widget does
      if (p.filter(Boolean).length === m.n) msgs.push(JSON.parse(p.join('')));
    }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const until = (pred, ms = 8000) => waitFor(() => msgs.find(pred), ms);
  const done = (id) => until((m) => m.t === 'done' && m.id === id);
  const run = async (id, source) => { send({ t: 'run', id, source }); return done(id); };
  const exited = new Promise((r) => child.on('close', r));
  return { child, msgs, raw, send, until, run, done, exited, close: () => { child.stdin.end(); return exited; } };
}
const text = (d) => d.outputs.map((o) => o.text || '').join('');

test('runner: variables carry over, the last expression is shown, tables and errors are readable', opts, async () => {
  const dir = tmp(); const k = kernel(dir);
  try {
    await k.until((m) => m.t === 'ready');
    assert.deepEqual((await k.run('a', 'x = 20\nprint("hi")\nx + 1')).outputs, [{ t: 'stream', name: 'stdout', text: 'hi\n' }, { t: 'result', text: '21' }]);
    assert.equal(text(await k.run('b', 'x * 2')), '40', 'a variable from an earlier cell');
    const table = (await k.run('c', '[{"a": 1, "b": "x"}, {"a": 2}]')).outputs[0];
    assert.deepEqual(table, { t: 'table', columns: ['a', 'b'], rows: [[1, 'x'], [2, null]] });
    assert.equal((await k.run('d', '{"k": 1, "j": "v"}')).outputs[0].t, 'table');
    assert.equal((await k.run('e', 'object()')).outputs[0].t, 'result', 'not simple data: plain text');
    const err = await k.run('f', 'def f():\n    return 1/0\nf()');
    assert.equal(err.status, 'error'); assert.match(err.outputs[0].text, /ZeroDivisionError/); assert.doesNotMatch(err.outputs[0].text, /runner\.py/, 'the runner frames are hidden');
    assert.equal((await k.run('g', 'import sys; print("e", file=sys.stderr)')).outputs[0].name, 'stderr');
    assert.match(text(await k.run('h', 'exit(3)')), /ignored/); assert.equal(text(await k.run('i', 'x')), '20', 'exit() leaves the kernel alive');
    assert.equal(text(await k.run('j', 'input()')).includes('EOFError'), true, 'input() fails instead of hanging on the protocol');
  } finally { await k.close(); }
});

test('runner: Stop interrupts a long cell and the kernel stays usable; Restart clears variables', opts, async () => {
  const dir = tmp(); const k = kernel(dir);
  try {
    await k.until((m) => m.t === 'ready');
    await k.run('a', 'keep = 7');
    k.send({ t: 'run', id: 'slow', source: 'import time\ntime.sleep(60)' });
    k.send({ t: 'run', id: 'queued', source: 'print("never")' });
    await k.until((m) => m.t === 'start' && m.id === 'slow');
    const t0 = Date.now(); k.send({ t: 'stop' });
    const d = await k.done('slow'); assert.equal(d.status, 'interrupted'); assert.ok(Date.now() - t0 < 4000);
    await sleep(200); assert.equal(k.msgs.some((m) => m.t === 'start' && m.id === 'queued'), false, 'Stop drops the queue');
    assert.equal(text(await k.run('b', 'keep')), '7', 'variables survive a Stop');
    k.send({ t: 'restart' }); await k.until((m) => m.t === 'restarted');
    assert.match(text(await k.run('c', 'keep')), /NameError/);
  } finally { await k.close(); }
});

test('runner: notebook file survives, a later process says the kernel was lost, output is capped', opts, async () => {
  const dir = tmp(); let k = kernel(dir, { HATCH_NOTEBOOK_CAP: '2000' });
  await k.until((m) => m.t === 'ready');
  k.send({ t: 'cells', cells: [{ id: 'a', type: 'code', source: 'v = 5\nv' }, { id: 'm', type: 'markdown', source: '# t' }] });
  await k.run('a', 'v = 5\nv'); await k.run('big', 'print("x" * 100000)');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'notebook.json'), 'utf8'));
  assert.deepEqual(file.cells.map((c) => [c.id, c.type]), [['a', 'code'], ['m', 'markdown']]);
  assert.equal(file.cells[0].outputs[0].text, '5');
  await k.close();
  k = kernel(dir);
  try {
    await k.until((m) => m.t === 'ready');
    k.send({ t: 'hello' });
    const hello = await k.until((m) => m.t === 'hello'); assert.equal(hello.lost, true, 'a new process cannot have the old variables');
    const nb = await k.until((m) => m.t === 'notebook'); assert.equal(nb.cells[0].outputs[0].text, '5', 'outputs come back');
    assert.equal(nb.cells[1].source, '# t');
    assert.match(text(await k.run('x', 'v')), /NameError/);
    k.send({ t: 'hello' }); assert.equal((await waitFor(() => k.msgs.filter((m) => m.t === 'hello')[1])).lost, false, 'running a cell ends the lost state');
  } finally { await k.close(); }
  // the cap, on its own process
  k = kernel(dir, { HATCH_NOTEBOOK_CAP: '2000' });
  try {
    await k.until((m) => m.t === 'ready');
    const d = await k.run('big', 'print("x" * 100000)');
    assert.ok(text(d).length < 2300); assert.equal(d.outputs.at(-1).t, 'note'); assert.match(d.outputs.at(-1).text, /truncated/);
  } finally { await k.close(); }
});

test('runner: a long line is sent in pieces that join to the original message', opts, async () => {
  const k = kernel(tmp());
  try {
    await k.until((m) => m.t === 'ready');
    const d = await k.run('a', 'print("y" * 300000)'); assert.equal(text(d).length, 300001);
    // `done` was larger than one piece, so it arrived as chunks
    const parts = k.raw.filter((m) => m.t === 'chunk'); assert.ok(parts.length >= 3);
    const join = (mid) => JSON.parse(parts.filter((p) => p.mid === mid).sort((a, b) => a.i - b.i).map((p) => p.d).join(''));
    const joined = [...new Set(parts.map((p) => p.mid))].map(join).find((m) => m.t === 'done');
    assert.equal(joined.outputs[0].text.length, 300001);
  } finally { await k.close(); }
});

test('runner: figures come back as images when matplotlib is installed, and plain cells work without it', opts, async () => {
  const k = kernel(tmp());
  try {
    await k.until((m) => m.t === 'ready');
    assert.equal(text(await k.run('a', '1 + 1')), '2');
    if (!hasMpl) return;
    const d = await k.run('p', 'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])');
    const img = d.outputs.find((o) => o.t === 'image'); assert.ok(img); assert.equal(Buffer.from(img.data, 'base64').subarray(1, 4).toString(), 'PNG');
  } finally { await k.close(); }
});

const procsOf = (needle) => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(needle); } catch { return false; } });

test('widget processes: one per window, driven by hatch.call, killed with the window; per-window copies lose their folder', opts, async () => {
  const h = await startHatch();
  try {
    const a = (await h.call('POST', '/api/examples/notebook/open', {})).data; const b = (await h.call('POST', '/api/examples/notebook/open', {})).data;
    assert.deepEqual([a.props.name, b.props.name], ['notebook-1', 'notebook-2'], 'every open is a fresh notebook');
    const widgets = path.join(h.stateDir, 'widgets');
    const sse = readSse(`${h.base}/api/source/notebook-1/kernel`, { 'x-token': h.hatch.token }, (ev) => ev.some((e) => e.data.includes('"t\\":\\"notebook\\"')), 8000);
    await sleep(300);
    await h.call('POST', '/api/call', { widget: 'notebook-1', source: 'kernel', arg: JSON.stringify({ t: 'hello' }) });
    const lines = (await sse).map((e) => JSON.parse(JSON.parse(e.data).value.line));
    assert.ok(lines.some((m) => m.t === 'hello')); assert.ok(lines.some((m) => m.t === 'notebook'));
    const mark = path.join(widgets, 'notebook-1', 'runner.py');
    await waitFor(() => procsOf(mark).length === 1);
    assert.equal(procsOf(path.join(widgets, 'notebook-2', 'runner.py')).length, 0, 'the other window has no kernel until it is used');
    // a view-only style call with a newline is refused
    assert.equal((await h.call('POST', '/api/call', { widget: 'notebook-1', source: 'kernel', arg: 'a\nb' })).status, 400);
    await h.call('POST', '/api/call', { widget: 'notebook-1', source: 'kernel', arg: JSON.stringify({ t: 'cells', cells: [{ id: 'q', type: 'code', source: '1' }] }) });
    await waitFor(() => fs.existsSync(path.join(widgets, 'notebook-1', 'data', 'notebook.json')));
    // closing the window ends the process and removes the notebook
    assert.equal((await h.call('DELETE', '/api/panels/w-notebook-1')).status, 200);
    await waitFor(() => procsOf(mark).length === 0, 5000);
    await waitFor(() => !fs.existsSync(path.join(widgets, 'notebook-1')));
    assert.ok(fs.existsSync(path.join(widgets, 'notebook-2')), 'the other notebook is untouched');
  } finally { await h.close(); }
  assert.equal(procsOf('notebook-2/runner.py').length, 0, 'stopping the server leaves no kernel behind');
});

test('widget processes: a missing python3 gives a readable message instead of a hang', async () => {
  const h = await startHatch(); const oldPath = process.env.PATH;
  try {
    const w = (await h.call('POST', '/api/examples/notebook/open', {})).data.props.name;
    process.env.PATH = tmp(); // no python3 here
    const sse = readSse(`${h.base}/api/source/${w}/kernel`, { 'x-token': h.hatch.token }, (ev) => ev.some((e) => e.data.includes('exit')), 6000);
    const ev = (await sse).map((e) => JSON.parse(e.data).value);
    assert.match(ev.find((v) => v.line)?.line, /python3 was not found/); assert.equal(ev.find((v) => v.exit)?.exit.code, 3);
  } finally { process.env.PATH = oldPath; await h.close(); }
});

test('widget processes: any widget can declare a proc source; a perWindow copy without a window is removed at start', async () => {
  const dir = tmp(); const state = path.join(dir, '.hatch');
  const meta = { perWindow: true, sources: [{ name: 'p', kind: 'proc', cmd: 'cat' }] };
  for (const n of ['orphan']) { fs.mkdirSync(path.join(state, 'widgets', n, 'data'), { recursive: true }); fs.writeFileSync(path.join(state, 'widgets', n, 'index.html'), 'x'); fs.writeFileSync(path.join(state, 'widgets', n, 'widget.json'), JSON.stringify(meta)); }
  const hatch = createHatch({ stateDir: state, host: '127.0.0.1', port: 0, attach: ['cat'], cwd: dir, pollState: true, findBin: () => null });
  const base = `http://127.0.0.1:${await hatch.listen()}`; const headers = { 'x-token': hatch.token, 'content-type': 'application/json' };
  try {
    await waitFor(() => !fs.existsSync(path.join(state, 'widgets', 'orphan'))); // no window shows it, so it is gone
    await fetch(`${base}/api/widgets/echo`, { method: 'PUT', headers, body: JSON.stringify({ files: { 'index.html': 'x' }, meta: { sources: [{ name: 'p', kind: 'proc', cmd: 'cat' }] } }) });
    const sse = readSse(`${base}/api/source/echo/p`, { 'x-token': hatch.token }, (ev) => ev.some((e) => e.data.includes('ping-1')), 4000);
    await sleep(300);
    await fetch(`${base}/api/call`, { method: 'POST', headers, body: JSON.stringify({ widget: 'echo', source: 'p', arg: 'ping-1' }) });
    assert.ok((await sse).some((e) => JSON.parse(e.data).value.line === 'ping-1'), 'a line sent to the process comes back on the subscription');
  } finally { await hatch.close(); }
});
