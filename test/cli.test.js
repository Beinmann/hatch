import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHatch, tmp, PNG, waitFor, pendingAsks } from './helpers.js';

const UI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
// async spawn: the server runs in this same process, so a sync spawn would deadlock it
const FAKE_HOME = tmp(); // never the real ~: the default state dir is ~/.hatch
const ui = (args, { state, input, cwd, env } = {}) => new Promise((resolve) => {
  const p = spawn('node', [UI, ...(state ? ['--state', state] : []), ...args], { cwd, env: { ...process.env, HOME: FAKE_HOME, HATCH_STATE: '', HATCH_WORKSPACE: '', ...env } });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
  p.stdin.end(input || '');
});

test('ui CLI end to end against a real server', async () => {
  const h = await startHatch();
  const s = h.stateDir;
  try {
    let r = await ui(['note', '# hello', '--title', 'N'], { state: s }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /p1/);
    const png = path.join(h.dir, 'x.png'); fs.writeFileSync(png, PNG);
    r = await ui(['image', png], { state: s }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['open', 'http://localhost:3000'], { state: s }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['panels', '--json'], { state: s }); assert.equal(JSON.parse(r.stdout).length, 3);
    r = await ui(['close', 'p1'], { state: s }); assert.equal(r.status, 0);
    r = await ui(['notify', 'done!', '--level', 'done'], { state: s }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['notify', 'x', '--level', 'loud'], { state: s }); assert.equal(r.status, 1);

    r = await ui(['progress', 'set', '-'], { state: s, input: 'flowchart LR\n  build --> test\n' }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['progress', 'step', 'build', 'running'], { state: s }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['progress', 'step', 'Write the docs', 'todo'], { state: s }); assert.equal(r.status, 0);
    r = await ui(['progress', 'step', 'Write the docs', 'done'], { state: s });
    r = await ui(['progress', 'show', '--json'], { state: s });
    const p = JSON.parse(r.stdout); assert.equal(p.steps.length, 2); assert.equal(p.steps.find((x) => x.id === 'write_the_docs').status, 'done');
    assert.match(p.diagram, /class build running/);
    r = await ui(['progress', 'step', 'build', 'wat'], { state: s }); assert.equal(r.status, 1);

    r = await ui(['widget', 'new', 'cpu', '--from', 'cpu'], { state: s }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['widget', 'new', 'cpu'], { state: s }); assert.equal(r.status, 1, 'already exists');
    r = await ui(['widget', 'open', 'cpu'], { state: s }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['widget', 'list', '--json'], { state: s }); assert.equal(JSON.parse(r.stdout)[0].open, true);
    assert.ok(!r.stdout.includes('widget generate'), 'no hint in JSON');
    r = await ui(['widget', 'list'], { state: s }); assert.match(r.stdout.trimEnd().split('\n').pop(), /hatch widget generate "<prompt>"/);
    const single = path.join(h.dir, 'one.html'); fs.writeFileSync(single, '<p>x</p>');
    r = await ui(['widget', 'add', 'one', single], { state: s }); assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(s, 'widgets/one/index.html')));
    r = await ui(['widget', 'rm', 'one'], { state: s }); assert.equal(r.status, 0, r.stderr);
    await waitFor(() => !fs.existsSync(path.join(s, 'widgets/one')));
    r = await ui(['widget', 'add', 'nothing'], { state: s }); assert.equal(r.status, 1);

    r = await ui(['upload-dir'], { state: s }); assert.equal(r.stdout.trim(), path.join(s, 'uploads'));
    r = await ui(['bogus'], { state: s }); assert.equal(r.status, 1);
    r = await ui(['--help']); assert.match(r.stdout, /progress set/);
    r = await ui(['widget', 'new', '--help']); assert.match(r.stdout, /postMessage/);
  } finally { await h.close(); }
});

test('ui does not walk up to a project .hatch; it uses HATCH_STATE, else ~/.hatch, and exits 2 when the server is down', async () => {
  const h = await startHatch(); // its state dir is <dir>/.hatch: a project-local one
  const sub = path.join(h.dir, 'a', 'b'); fs.mkdirSync(sub, { recursive: true });
  let r = await ui(['panels'], { cwd: sub }); assert.equal(r.status, 2, 'the project .hatch above the cwd is ignored'); assert.match(r.stderr, /no Hatch instance found/); assert.match(r.stderr, /hatch migrate/);
  r = await ui(['panels'], { cwd: sub, env: { HATCH_STATE: h.stateDir } }); assert.equal(r.status, 0, r.stderr);
  const home = tmp(); fs.cpSync(h.stateDir, path.join(home, '.hatch'), { recursive: true }); // the default location
  r = await ui(['panels'], { cwd: sub, env: { HOME: home } }); assert.equal(r.status, 0, r.stderr);
  await h.close();
  r = await ui(['panels'], { cwd: sub, env: { HATCH_STATE: h.stateDir } }); assert.equal(r.status, 2); assert.match(r.stderr, /hatch-server start/);
});

test('HATCH_WORKSPACE: windows go to that workspace; --ws wins; main when unset', async () => {
  const h = await startHatch();
  try {
    await ui(['workspace', 'new', 'proj'], { state: h.stateDir });
    await ui(['workspace', 'new', 'other'], { state: h.stateDir });
    const wsOf = async (id) => (JSON.parse((await ui(['panels', '--json'], { state: h.stateDir })).stdout).find((p) => p.id === id) || {}).ws;
    let r = await ui(['note', 'a'], { state: h.stateDir }); assert.equal(await wsOf(r.stdout.match(/p\d+/)[0]) || 'main', 'main');
    r = await ui(['note', 'b'], { state: h.stateDir, env: { HATCH_WORKSPACE: 'proj' } }); assert.equal(await wsOf(r.stdout.match(/p\d+/)[0]), 'proj');
    r = await ui(['note', 'c', '--ws', 'other'], { state: h.stateDir, env: { HATCH_WORKSPACE: 'proj' } }); assert.equal(await wsOf(r.stdout.match(/p\d+/)[0]), 'other');
  } finally { await h.close(); }
});

test('saved commands: add, list, replace, remove; bad file gives a warning not a crash', async () => {
  const h = await startHatch();
  const s = h.stateDir;
  try {
    let r = await ui(['cmd', 'add', 'tests', 'npm', 'test'], { state: s }); assert.equal(r.status, 0, r.stderr);
    r = await ui(['cmd', 'add', 'wip', 'git status', '--no-enter'], { state: s });
    r = await ui(['cmd', 'list', '--json'], { state: s });
    const list = JSON.parse(r.stdout); assert.equal(list.length, 2); assert.equal(list.find((c) => c.name === 'tests').text, 'npm test'); assert.equal(list.find((c) => c.name === 'wip').enter, false);
    r = await ui(['cmd', 'add', 'tests', 'npm run t'], { state: s });
    assert.equal(JSON.parse((await ui(['cmd', 'list', '--json'], { state: s })).stdout).find((c) => c.name === 'tests').text, 'npm run t');
    r = await ui(['cmd', 'rm', 'nope'], { state: s }); assert.equal(r.status, 1);
    r = await ui(['cmd', 'rm', 'wip'], { state: s }); assert.equal(r.status, 0);
    fs.writeFileSync(path.join(s, 'commands.json'), '{nope');
    assert.deepEqual((await h.call('GET', '/api/commands')).data, []);
    assert.ok(h.hatch.state.snapshot().warnings.some((w) => w.file === 'commands.json'));
  } finally { await h.close(); }
});

test('example widgets are valid: every source in widget.json passes checkSource and has an index.html that loads the SDK', async () => {
  const { checkSource } = await import('../src/sources.js');
  const root = fileURLToPath(new URL('../examples/widgets/', import.meta.url));
  for (const name of fs.readdirSync(root)) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'widget.json'), 'utf8'));
    for (const src of meta.sources) assert.equal(checkSource(src).error, undefined, `${name}/${src.name}`);
    assert.match(fs.readFileSync(path.join(root, name, 'index.html'), 'utf8'), /\/sdk\.js/, name);
  }
});

test('widget new: without --from a minimal template, with --from a copy of that example, unknown example refused', async () => {
  const h = await startHatch();
  try {
    let r = await ui(['widget', 'new', 'mini'], { state: h.stateDir }); assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(h.stateDir, 'widgets/mini/index.html'), 'utf8'), /sdk\.js/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'widgets/mini/widget.json'), 'utf8')).title, 'mini');
    r = await ui(['widget', 'new', 'c2', '--from', 'clock'], { state: h.stateDir }); assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(h.stateDir, 'widgets/c2/index.html')));
    r = await ui(['widget', 'new', 'x', '--from', 'blank'], { state: h.stateDir }); assert.equal(r.status, 1); assert.match(r.stderr, /no example blank/);
  } finally { await h.close(); }
});

test('ask: the CLI blocks until an answer arrives; defaults, free text, timeout and cancel', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    const pending = ui(['ask', 'Deploy now?'], { state: s });
    const q = await waitFor(async () => (await pendingAsks(h)).find(question => question.question === 'Deploy now?'));
    assert.equal((await h.call('GET', `/api/ask/${q.id}`)).data.answered, false);
    assert.equal((await h.call('POST', `/api/ask/${q.id}/answer`, { answer: 5 })).status, 400);
    assert.equal((await h.call('POST', `/api/ask/${q.id}/answer`, { answer: 'Yes' })).status, 200);
    const r = await pending; assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'Yes');
    const timing = ui(['ask', 'Anyone there?', '--timeout', '1'], { state: s });
    const timed = await waitFor(async () => (await pendingAsks(h)).find(question => question.question === 'Anyone there?'));
    const t = await timing; assert.equal(t.status, 3); assert.match(t.stderr, /timeout/);
    assert.equal((await h.call('GET', `/api/ask/${timed.id}`)).status, 404, 'timed out question is removed');
    const free = ui(['ask', 'Which branch?', '--text'], { state: s });
    const freeQuestion = await waitFor(async () => (await pendingAsks(h)).find(question => question.question === 'Which branch?'));
    const snap = await (await import('./helpers.js')).readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.length > 0);
    const asks = JSON.parse(snap[0].data).asks; assert.equal(asks.length, 1); assert.equal(asks[0].freeText, true); assert.deepEqual(asks[0].choices, []);
    await h.call('POST', `/api/ask/${freeQuestion.id}/answer`, { answer: 'main' }); assert.equal((await free).stdout.trim(), 'main');
    assert.equal((await ui(['ask', ''], { state: s })).status, 1);
  } finally { await h.close(); }
});

test('desktop opens the gadget set, is idempotent, and every gadget has a working widget.json', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    let r = await ui(['desktop'], { state: s }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /graph.*clock/);
    const panels = JSON.parse((await ui(['panels', '--json'], { state: s })).stdout);
    assert.ok(panels.filter((p) => p.type === 'widget').length >= 5);
    const top = panels.find((p) => p.type === 'terminal'); assert.equal(top.props.name, 'top'); assert.match(top.props.cmd, /htop.*top/, 'top popup is an interactive terminal preferring htop'); assert.ok(panels.some((p) => p.type === 'progress'));
    await ui(['desktop'], { state: s });
    assert.equal(JSON.parse((await ui(['panels', '--json'], { state: s })).stdout).length, panels.length, 'second run adds nothing');
    for (const name of ['graph', 'clock', 'git']) assert.ok(fs.existsSync(path.join(s, 'widgets', name, 'index.html')));
  } finally { await h.close(); }
});

test('widget open top and popup open top give the interactive terminal', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    for (const args of [['widget', 'open', 'top'], ['popup', 'open', 'top']]) {
      const r = await ui(args, { state: s }); assert.equal(r.status, 0, r.stderr);
    }
    const panels = JSON.parse((await ui(['panels', '--json'], { state: s })).stdout);
    assert.ok(!panels.some((p) => p.type === 'widget' && p.props.name === 'top'));
    assert.ok(panels.some((p) => p.type === 'terminal' && p.props.name === 'top' && /htop/.test(p.props.cmd)));
  } finally { await h.close(); }
});

test('desktop replaces an older top widget window with the terminal', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    await fetch(`${h.base}/api/panels`, { method: 'POST', headers: { 'x-token': h.hatch.token, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'widget', props: { name: 'top' } }) });
    await ui(['desktop'], { state: s });
    const panels = JSON.parse((await ui(['panels', '--json'], { state: s })).stdout);
    assert.ok(!panels.some((p) => p.type === 'widget' && p.props.name === 'top'), 'old top widget window is gone');
    assert.equal(panels.filter((p) => p.type === 'terminal' && p.props.name === 'top').length, 1);
  } finally { await h.close(); }
});

test('copy: text from the CLI or stdin reaches the event stream; empty is refused', async () => {
  const { readSse } = await import('./helpers.js');
  const h = await startHatch(); const s = h.stateDir;
  try {
    const got = readSse(`${h.base}/api/events`, { 'x-token': h.hatch.token }, (e) => e.filter((x) => x.event === 'copy').length >= 2, 5000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await ui(['copy', 'hello', 'world'], { state: s })).status, 0);
    assert.equal((await ui(['copy', '-'], { state: s, input: 'from stdin\n' })).status, 0);
    assert.equal((await ui(['copy', '-'], { state: s, input: '' })).status, 1);
    const texts = (await got).filter((x) => x.event === 'copy').map((x) => JSON.parse(x.data).text);
    assert.deepEqual(texts, ['hello world', 'from stdin\n']);
    assert.equal((await h.call('POST', '/api/copy', {})).status, 400);
  } finally { await h.close(); }
});

test('--ws puts the opened window into that workspace', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    assert.equal((await ui(['note', 'a', '--ws', 'build'], { state: s })).status, 0); await ui(['note', 'b'], { state: s });
    const panels = JSON.parse((await ui(['panels', '--json'], { state: s })).stdout);
    assert.equal(panels.find((p) => p.props.markdown === 'a').ws, 'build'); assert.equal(panels.find((p) => p.props.markdown === 'b').ws, undefined);
  } finally { await h.close(); }
});

test('prompt: multi-line prompts are saved as paste entries and listed apart from commands', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    assert.equal((await ui(['prompt', 'add', 'review', '-'], { state: s, input: 'Please review this change.\nFocus on bugs.\n' })).status, 0);
    await ui(['cmd', 'add', 'tests', 'npm', 'test'], { state: s });
    const list = (await h.call('GET', '/api/commands')).data; const p = list.find((c) => c.name === 'review');
    assert.equal(p.paste, true); assert.equal(p.enter, false); assert.equal(p.text, 'Please review this change.\nFocus on bugs.'); assert.equal(list.find((c) => c.name === 'tests').paste, undefined);
    assert.equal((await ui(['prompt', 'list'], { state: s })).stdout.trim(), 'review: Please review this change. ...');
    assert.equal((await ui(['prompt', 'rm', 'tests'], { state: s })).status, 1, 'a command is not a prompt');
    assert.equal((await ui(['prompt', 'rm', 'review'], { state: s })).status, 0);
  } finally { await h.close(); }
});

test('bookmarks: add, list with kind, replace, remove; missing paths are flagged; bad file is empty', async () => {
  const h = await startHatch(); const s = h.stateDir; const d = path.join(h.dir, 'proj'); fs.mkdirSync(d); const f = path.join(h.dir, 'n.txt'); fs.writeFileSync(f, 'x');
  try {
    assert.equal((await ui(['bookmark', 'add', 'proj', d], { state: s })).status, 0); await ui(['bookmark', 'add', 'notes', f], { state: s });
    let list = JSON.parse((await ui(['bookmark', 'list', '--json'], { state: s })).stdout); assert.deepEqual(list.map((b) => [b.name, b.kind]).sort(), [['notes', 'file'], ['proj', 'dir']]);
    await ui(['bookmark', 'add', 'proj', f], { state: s }); list = (await h.call('GET', '/api/bookmarks')).data; assert.equal(list.length, 2); assert.equal(list.find((b) => b.name === 'proj').kind, 'file');
    fs.rmSync(f); assert.equal((await h.call('GET', '/api/bookmarks')).data.find((b) => b.name === 'notes').kind, 'missing');
    assert.equal((await ui(['bookmark', 'add', 'x', '/nope/nowhere'], { state: s })).status, 1); assert.equal((await ui(['bookmark', 'rm', 'ghost'], { state: s })).status, 1);
    assert.equal((await ui(['bookmark', 'rm', 'proj'], { state: s })).status, 0);
    assert.equal((await h.call('PUT', '/api/bookmarks', { nope: 1 })).status, 400);
    fs.writeFileSync(path.join(s, 'bookmarks.json'), '{x'); assert.deepEqual((await h.call('GET', '/api/bookmarks')).data, []);
  } finally { await h.close(); }
});

test('widget examples: listed with titles; opening one copies it once and opens a window', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    const list = (await h.call('GET', '/api/examples')).data; assert.ok(list.length >= 10); assert.ok(list.some((e) => e.name === 'cpu' && e.title === 'CPU'));
    assert.match((await ui(['widget', 'examples'], { state: s })).stdout, /sysinfo\s+System/);
    const p1 = await h.call('POST', '/api/examples/cpu/open', {}); assert.equal(p1.status, 200); assert.equal(p1.data.id, 'w-cpu');
    assert.ok(fs.existsSync(path.join(s, 'widgets/cpu/index.html')));
    fs.writeFileSync(path.join(s, 'widgets/cpu/index.html'), '<p>my edit</p>'); await h.call('POST', '/api/examples/cpu/open', {});
    assert.equal(fs.readFileSync(path.join(s, 'widgets/cpu/index.html'), 'utf8'), '<p>my edit</p>', 'an existing copy is never overwritten');
    assert.equal((await h.call('POST', '/api/examples/nope/open', {})).status, 404);
  } finally { await h.close(); }
});

test('trash is a built-in widget: listed, opens the trash panel once, restore works', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    let r = await ui(['widget', 'list'], { state: s }); assert.match(r.stdout, /^trash +closed +built-in +Trash$/m);
    r = await ui(['widget', 'open', 'trash'], { state: s }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /trash open as /);
    assert.match((await ui(['widget', 'list'], { state: s })).stdout, /^trash +open +built-in/m);
    await ui(['widget', 'open', 'trash'], { state: s });
    assert.equal((await h.call('GET', '/api/panels')).data.filter((p) => p.type === 'trash').length, 1);
    const note = (await h.call('POST', '/api/panels', { type: 'note', title: 'gone', props: { markdown: 'x' } })).data;
    await h.call('DELETE', `/api/panels/${note.id}`);
    assert.equal((await h.call('GET', '/api/trash')).data.length, 1);
    assert.equal((await h.call('POST', '/api/trash/restore', {})).status, 200);
  } finally { await h.close(); }
});

test('widget open/list include bundled examples; installed copies win; unknown names point to widget list', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    let r = await ui(['widget', 'list'], { state: s }); assert.match(r.stdout, /^cpu +closed +example +\S/m);
    const rows = r.stdout.split('\n\n')[0].split('\n'); assert.match(rows[0], /^NAME +STATE +KIND +TITLE$/);
    const col = rows[0].indexOf('STATE'); assert.ok(rows.every((l) => l[col - 1] === ' ' && l[col] !== ' '), 'STATE column aligned');
    assert.match(r.stdout, /Create your own widgets/);
    const j = JSON.parse((await ui(['widget', 'list', '--json'], { state: s })).stdout);
    assert.ok(j.some((w) => w.name === 'cpu' && w.example === true)); assert.ok(j.every((w) => typeof w.name === 'string'));
    r = await ui(['widget', 'open', 'cpu'], { state: s }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /cpu open as w-cpu/);
    assert.ok(fs.existsSync(path.join(s, 'widgets/cpu/index.html')));
    assert.match((await ui(['widget', 'list'], { state: s })).stdout, /^cpu +open +installed/m);
    assert.ok(!JSON.parse((await ui(['widget', 'list', '--json'], { state: s })).stdout).find((w) => w.name === 'cpu').example);
    fs.writeFileSync(path.join(s, 'widgets/cpu/index.html'), '<p>my edit</p>'); await ui(['widget', 'open', 'cpu'], { state: s });
    assert.equal(fs.readFileSync(path.join(s, 'widgets/cpu/index.html'), 'utf8'), '<p>my edit</p>');
    r = await ui(['popup', 'open', 'sysinfo'], { state: s }); assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /deprecated.*hatch widget open sysinfo/);
    r = await ui(['widget', 'open', 'nope-nothing'], { state: s }); assert.equal(r.status, 1); assert.match(r.stderr, /no widget nope-nothing.*hatch widget list/);
  } finally { await h.close(); }
});

test('hatch service prints a systemd unit with absolute paths and the given options; installs nothing', async () => {
  const { spawnSync } = await import('node:child_process'); const HATCH = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));
  const r = spawnSync('node', [HATCH, 'service', '--state', '/srv/my proj/.hatch', '--port', '7070'], { encoding: 'utf8', cwd: tmp() });
  assert.equal(r.status, 0); assert.match(r.stdout, /\[Service\]/); assert.match(r.stdout, /ExecStart=.*node.* .*hatch-server\.js serve --state "\/srv\/my proj\/\.hatch" --port 7070/);
  assert.match(r.stdout, /WorkingDirectory="\/srv\/my proj"/); assert.match(r.stdout, /loginctl enable-linger/);
});

test('export/import: a setup moves between state dirs without the token; existing files survive unless --force; foreign archives are refused', async () => {
  const { spawnSync } = await import('node:child_process'); if (spawnSync('tar', ['--version']).status !== 0) return;
  const a = await startHatch(); const b = await startHatch(); const out = path.join(tmp(), 'setup.tgz');
  try {
    await ui(['cmd', 'add', 'tests', 'npm test'], { state: a.stateDir }); await ui(['widget', 'new', 'w1'], { state: a.stateDir }); fs.writeFileSync(path.join(a.stateDir, 'custom.css'), ':root{--accent:red}');
    assert.equal((await ui(['export', out], { state: a.stateDir })).status, 0);
    const listing = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' }).stdout; assert.doesNotMatch(listing, /config\.json|uploads|log/); assert.match(listing, /commands\.json/); assert.match(listing, /widgets\/w1\/index\.html/);
    fs.writeFileSync(path.join(b.stateDir, 'custom.css'), 'KEEP ME');
    const r = await ui(['import', out], { state: b.stateDir }); assert.equal(r.status, 0, r.stderr);
    assert.equal((await b.call('GET', '/api/commands')).data[0].name, 'tests'); assert.ok(fs.existsSync(path.join(b.stateDir, 'widgets/w1/index.html')));
    assert.equal(fs.readFileSync(path.join(b.stateDir, 'custom.css'), 'utf8'), 'KEEP ME', 'an existing file is kept');
    assert.equal((await ui(['import', out, '--force'], { state: b.stateDir })).status, 0); assert.equal(fs.readFileSync(path.join(b.stateDir, 'custom.css'), 'utf8'), ':root{--accent:red}');
    const evil = tmp(); fs.writeFileSync(path.join(evil, 'config.json'), '{"token":"x"}'); const evilTgz = path.join(tmp(), 'evil.tgz'); spawnSync('tar', ['-czf', evilTgz, '-C', evil, 'config.json']);
    const bad = await ui(['import', evilTgz], { state: b.stateDir }); assert.equal(bad.status, 1); assert.match(bad.stderr, /not part of a Hatch setup/);
    assert.equal((await ui(['import', path.join(evil, 'config.json')], { state: b.stateDir })).status, 1, 'not a tgz');
    // a symlink entry inside an allowed directory is refused (it could redirect a later entry outside the state dir)
    const link = tmp(); fs.mkdirSync(path.join(link, 'widgets')); fs.symlinkSync('/tmp', path.join(link, 'widgets', 'escape')); const linkTgz = path.join(tmp(), 'link.tgz'); spawnSync('tar', ['-czf', linkTgz, '-C', link, 'widgets']);
    const l = await ui(['import', linkTgz], { state: b.stateDir }); assert.equal(l.status, 1); assert.match(l.stderr, /link or special file/); assert.ok(!fs.existsSync(path.join(b.stateDir, 'widgets', 'escape')));
  } finally { await a.close(); await b.close(); }
});

// The child gets a clean environment: with HATCH_STATE from the developer's shell it would start a real server on that state dir
// (and rewrite its config.json) instead of failing.
test('hatch serve in an unwritable place explains itself instead of printing a stack trace', async () => {
  if (process.getuid?.() === 0) return; // root can write anywhere
  const { spawnSync } = await import('node:child_process'); const HATCH = fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url));
  const d = tmp(); fs.chmodSync(d, 0o555);
  try { const r = spawnSync('node', [HATCH, 'serve', '--port', '0', '--yes', '--state', path.join(d, '.hatch')], { cwd: d, encoding: 'utf8', timeout: 8000, env: { PATH: process.env.PATH, HOME: tmp() } }); assert.equal(r.status, 1); assert.match(r.stderr, /cannot create the state dir .*(EACCES|EPERM|EROFS).*--state/); assert.doesNotMatch(r.stderr, /at .*node:fs/); }
  finally { fs.chmodSync(d, 0o755); }
});

test('widget generate: runs claude -p, scaffolds the widget and opens it; failures explain themselves', async () => {
  const h = await startHatch(); const s = h.stateDir;
  try {
    const fake = path.join(h.dir, 'fake-claude'); // stands in for claude: ignores stdin, prints a reply with fenced blocks
    fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\nprintf \'Here:\\n```html\\n<p>hi</p>\\n```\\n```json\\n{"title":"Hi"}\\n```\\n\'\n', { mode: 0o755 });
    let r = await ui(['popup', 'generate', 'a tiny greeter', '--name', 'greeter'], { state: s, env: { HATCH_CLAUDE: fake } });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /open as/);
    assert.equal(fs.readFileSync(path.join(s, 'widgets/greeter/index.html'), 'utf8'), '<p>hi</p>\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s, 'widgets/greeter/widget.json'), 'utf8')).title, 'Hi');
    r = await ui(['widget', 'generate', 'again', '--name', 'greeter'], { state: s, env: { HATCH_CLAUDE: fake } }); assert.equal(r.status, 1); assert.match(r.stderr, /already exists/);
    r = await ui(['widget', 'generate', 'x'], { state: s, env: { HATCH_CLAUDE: path.join(h.dir, 'nope') } }); assert.equal(r.status, 1); assert.match(r.stderr, /not found.*HATCH_CLAUDE/);
    const bad = path.join(h.dir, 'bad-claude'); fs.writeFileSync(bad, '#!/bin/sh\necho boom >&2\nexit 3\n', { mode: 0o755 });
    r = await ui(['widget', 'generate', 'x'], { state: s, env: { HATCH_CLAUDE: bad } }); assert.equal(r.status, 1); assert.match(r.stderr, /failed \(exit 3\).*boom/);
    assert.ok(!fs.existsSync(path.join(s, 'widgets/x')));
    const early = path.join(h.dir, 'early-claude');
    fs.writeFileSync(early, '#!/bin/sh\nexec 0<&-\necho "not signed in" >&2\nexit 3\n', { mode: 0o755 });
    r = await ui(['widget', 'generate', 'x'.repeat(100000)], { state: s, env: { HATCH_CLAUDE: early } });
    assert.equal(r.status, 1); assert.match(r.stderr, /failed \(exit 3\).*not signed in/); assert.doesNotMatch(r.stderr, /EPIPE/);
  } finally { await h.close(); }
});

test('hatch-ui is a deprecated alias that behaves like hatch image', async () => {
  const h = await startHatch();
  try {
    const png = path.join(h.dir, 'y.png'); fs.writeFileSync(png, PNG);
    const HATCH = fileURLToPath(new URL('../bin/ui.js', import.meta.url));
    // async spawn for the same reason as ui(): the server shares this process
    const r = await new Promise((resolve) => { const p = spawn('node', [HATCH, 'image', png, '--title', 'Y'], { env: { ...process.env, HATCH_STATE: h.stateDir } }); let e = ''; p.stderr.on('data', (d) => { e += d; }); p.on('close', (status) => resolve({ status, e })); });
    assert.equal(r.status, 0, r.e);
    const list = await ui(['panels', '--json'], { state: h.stateDir });
    assert.ok(JSON.parse(list.stdout).some((x) => x.type === 'image' && x.title === 'Y'));
  } finally { await h.close(); }
});

test('ask rejects invalid timeout values before creating a pending question', async () => {
  const h = await startHatch();
  try {
    for (const timeout of ['-1', '0', 'NaN', 'Infinity', '1e308']) {
      const result = await ui(['ask', 'Must not appear', '--timeout', timeout], { state: h.stateDir });
      assert.equal(result.status, 1); assert.match(result.stderr, /positive finite/);
    }
    assert.deepEqual(await pendingAsks(h), []);
  } finally { await h.close(); }
});

test('old server commands under hatch still work but print a one-line notice naming hatch-server', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', [UI, 'service', '--state', '/srv/p/.hatch'], { encoding: 'utf8', cwd: tmp() });
  assert.equal(r.status, 0); assert.match(r.stdout, /\[Service\]/);
  assert.match(r.stderr, /`hatch service` moved to `hatch-server service`/); assert.equal(r.stderr.trim().split('\n').length, 1);
  const direct = spawnSync('node', [fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url)), 'service', '--state', '/srv/p/.hatch'], { encoding: 'utf8', cwd: tmp() });
  assert.equal(direct.status, 0); assert.equal(direct.stderr, '', 'hatch-server itself prints no notice');
  const help = spawnSync('node', [fileURLToPath(new URL('../bin/hatch-server.js', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /hatch-server serve/);
});

test('hatch page commands do not print the deprecation notice and exit 2 when the server is down', async () => {
  const r = await ui(['panels'], { cwd: tmp() });
  assert.equal(r.status, 2); assert.doesNotMatch(r.stderr, /moved to/);
});

test('host: prints the HATCH_URL based link, mentions the opened tabs, --no-open only prints', async () => {
  const { readSse } = await import('./helpers.js');
  const h = await startHatch(); const s = h.stateDir; const d = tmp(); fs.writeFileSync(path.join(d, 'p.html'), '<h1>x</h1>');
  try {
    const env = { HATCH_URL: 'https://proxy.example/hatch/' };
    let r = await ui(['host', path.join(d, 'p.html'), '--yes'], { state: s, env });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout.trim(), /^https:\/\/proxy\.example\/hatch\/host\/[0-9a-f]{10}\/p\.html$/, 'no secret in the link, also when no tab received it');
    assert.match(r.stderr, /No Hatch browser tab/);
    const got = readSse(`${h.base}/api/events?cid=c1`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'open-hosted'), 4000);
    await new Promise((x) => setTimeout(x, 300));
    r = await ui(['host', path.join(d, 'p.html'), '--yes'], { state: s, env });
    assert.match(r.stdout.trim(), /^https:\/\/proxy\.example\/hatch\/host\/[0-9a-f]{10}\/p\.html$/, 'cookie flow: no token in the link');
    assert.match(r.stderr, /Opened in 1 Hatch browser tab/);
    assert.equal((await got).filter((x) => x.event === 'open-hosted').length, 1);
    const got2 = readSse(`${h.base}/api/events?cid=c2`, { 'x-token': h.hatch.token }, (e) => e.some((x) => x.event === 'open-hosted'), 1200);
    await new Promise((x) => setTimeout(x, 300));
    r = await ui(['host', path.join(d, 'p.html'), '--yes', '--no-open'], { state: s, env });
    assert.doesNotMatch(r.stdout, /\?t=/); assert.match(r.stderr, /--no-open/);
    assert.equal((await got2).filter((x) => x.event === 'open-hosted').length, 0);
    r = await ui(['host', path.join(d, 'p.html'), '--yes', '--no-open'], { state: s });
    assert.match(r.stdout.trim(), /^http:\/\/127\.0\.0\.1:\d+\/host\//, 'without HATCH_URL the local server address');
  } finally { await h.close(); }
});
