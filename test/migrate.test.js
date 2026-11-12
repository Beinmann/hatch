import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.js';
import { findSource, workspaceNameFor } from '../src/migrate.js';

const CLI = fileURLToPath(new URL('../bin/hatch.js', import.meta.url));
const w = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`); };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

/** A project folder with an old-style .hatch: windows, an own workspace, background, commands, widgets, settings. */
function fixture() {
  const root = fs.realpathSync(tmp()); const project = path.join(root, 'My Project'); const s = path.join(project, '.hatch');
  const work = path.join(project, 'work'); fs.mkdirSync(work, { recursive: true });
  w(path.join(s, 'config.json'), { token: 'a'.repeat(32), session: 'hatch-old', port: 7070, host: '0.0.0.0', editor: 'builtin', imageSize: '800x550', allowedHosts: ['box.example'] });
  w(path.join(s, 'daemon.json'), { args: [], cwd: work });
  w(path.join(s, 'workspaces.json'), { version: 1, workspaces: [{ name: 'main', id: 'main' }, { name: 'docs', id: 'd1' }] });
  w(path.join(s, 'panels', 'p1.json'), { id: 'p1', type: 'terminal', title: 'shell', placement: 'float', props: { name: 'shell' }, x: 10, y: 20, w: 400, h: 300 });
  w(path.join(s, 'panels', 'p2.json'), { id: 'p2', type: 'widget', title: 'Clock', placement: 'float', props: { name: 'myclock' } });
  w(path.join(s, 'panels', 'p3.json'), { id: 'p3', type: 'note', title: 'N', placement: 'float', props: { markdown: '# hi' }, ws: 'docs' });
  w(path.join(s, 'panels', 'p4.json'), { id: 'p4', type: 'progress', title: 'Progress', placement: 'float', props: {} });
  fs.writeFileSync(path.join(s, 'background.png'), PNG); w(path.join(s, 'background.json'), { mode: 'fit' });
  fs.mkdirSync(path.join(s, 'workspaces', 'd1'), { recursive: true }); fs.writeFileSync(path.join(s, 'workspaces', 'd1', 'background.png'), Buffer.concat([PNG, Buffer.from('d1')]));
  w(path.join(s, 'widgets', 'myclock', 'index.html'), '<p>clock</p>'); w(path.join(s, 'widgets', 'myclock', 'data', 'x.json'), '{}');
  w(path.join(s, 'widgets', 'unused', 'index.html'), '<p>unused</p>');
  w(path.join(s, 'commands.json'), [{ name: 'tests', text: 'npm test', enter: true }, { name: 'greet', text: 'hello', enter: true, paste: true }]);
  w(path.join(s, 'schedules.json'), [{ name: 'tests', cmd: 'npm test', everySec: 300 }]);
  w(path.join(s, 'bookmarks.json'), [{ name: 'src', path: '/srv/src' }]);
  fs.writeFileSync(path.join(s, 'custom.css'), 'body{}'); fs.writeFileSync(path.join(s, 'custom.js'), 'export {}');
  w(path.join(s, 'fx.json'), { effect: 'rain' });
  return { root, project, s, work };
}
const tree = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => { const f = path.join(e.parentPath ?? e.path, e.name); return `${path.relative(dir, f)} ${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`; }).sort().join('\n');
// never the real ~: HOME is a temp dir; HATCH_STATE/HATCH_URL/HATCH_WORKSPACE of the developer's shell are removed
const hatch = (args, { cwd, home, env = {} }) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...env } });
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('findSource: DIR/.hatch, DIR as a state dir, and the walk-up for this command only', () => {
  const f = fixture(); const deep = path.join(f.project, 'a', 'b'); fs.mkdirSync(deep, { recursive: true });
  assert.equal(findSource(undefined, deep).srcDir, f.s);
  assert.equal(findSource(f.project).srcDir, f.s); assert.equal(findSource(f.project).project, 'My Project');
  assert.equal(findSource(f.s).srcDir, f.s); assert.equal(findSource(f.s).project, 'My Project');
  assert.throws(() => findSource(undefined, f.root), /no \.hatch found/);
  assert.throws(() => findSource(path.join(f.root, 'nope')), /not a folder/);
  assert.equal(workspaceNameFor('My Project'), 'My-Project'); assert.equal(workspaceNameFor('.x'), 'x');
});

test('migrate --dry-run prints the plan and changes nothing (the target is not even created)', () => {
  const f = fixture(); const home = fs.realpathSync(tmp()); const before = tree(f.s);
  const r = hatch(['migrate', '--dry-run'], { cwd: path.join(f.project, 'work'), home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN, nothing was changed/); assert.match(r.stdout, /workspace My-Project \(new\): 2 windows, terminals start in .*work/);
  assert.match(r.stdout, /workspace My-Project-docs \(new\): 1 window,/); assert.match(r.stdout, /window p1 \(terminal "shell"\) -> p1 in My-Project/);
  assert.match(r.stdout, /commands\.json.*add tests, greet/); assert.match(r.stdout, /widget unused: copy/); assert.match(r.stdout, /config\.json settings: add editor, imageSize/);
  assert.match(r.stdout, /progress windows are not imported/);
  assert.equal(fs.existsSync(path.join(home, '.hatch')), false); assert.equal(tree(f.s), before);
});

test('migrate imports into ~/.hatch of a temp HOME; the source is untouched; terminals get the start directory', () => {
  const f = fixture(); const home = fs.realpathSync(tmp()); const before = tree(f.s);
  let r = hatch(['migrate'], { cwd: f.work, home }); assert.equal(r.status, 1, 'no terminal and no --yes: it does not create ~/.hatch'); assert.match(r.stderr, /--yes/); assert.equal(fs.existsSync(path.join(home, '.hatch')), false);
  r = hatch(['migrate', '--yes'], { cwd: f.work, home }); assert.equal(r.status, 0, r.stderr);
  const t = path.join(home, '.hatch');
  assert.equal(tree(f.s), before, 'source dir is byte-identical');
  const reg = rj(path.join(t, 'workspaces.json')).workspaces; const main = reg.find((x) => x.name === 'My-Project'); const docs = reg.find((x) => x.name === 'My-Project-docs');
  assert.ok(main && docs); assert.equal(main.cwd, f.work); assert.equal(docs.cwd, f.work);
  const panels = fs.readdirSync(path.join(t, 'panels')).map((n) => rj(path.join(t, 'panels', n)));
  assert.equal(panels.length, 3, 'progress window not imported');
  const term = panels.find((p) => p.type === 'terminal'); assert.equal(term.ws, 'My-Project'); assert.equal(term.props.cwd, f.work); assert.equal(term.props.name, 'shell'); assert.equal(term.x, 10);
  assert.equal(panels.find((p) => p.type === 'note').ws, 'My-Project-docs');
  assert.ok(fs.existsSync(path.join(t, 'workspaces', main.id, 'background.png')) && fs.existsSync(path.join(t, 'workspaces', main.id, 'background.json')), 'background and its mode');
  assert.ok(fs.readFileSync(path.join(t, 'workspaces', docs.id, 'background.png')).includes('d1'), "the source workspace's own background");
  assert.ok(fs.existsSync(path.join(t, 'widgets', 'myclock', 'data', 'x.json')) && fs.existsSync(path.join(t, 'widgets', 'unused', 'index.html')));
  assert.deepEqual(rj(path.join(t, 'commands.json')).map((c) => c.name), ['tests', 'greet']); assert.equal(rj(path.join(t, 'commands.json'))[1].paste, true);
  assert.equal(rj(path.join(t, 'schedules.json'))[0].name, 'tests'); assert.equal(rj(path.join(t, 'bookmarks.json'))[0].path, '/srv/src');
  assert.equal(fs.readFileSync(path.join(t, 'custom.css'), 'utf8'), 'body{}'); assert.equal(fs.readFileSync(path.join(t, 'custom.js'), 'utf8'), 'export {}');
  const cfg = rj(path.join(t, 'config.json'));
  assert.equal(cfg.editor, 'builtin'); assert.deepEqual(cfg.allowedHosts, ['box.example']); assert.notEqual(cfg.token, 'a'.repeat(32), 'the old token is not carried over'); assert.equal(cfg.session, undefined);
  assert.match(r.stdout, /Next steps[\s\S]*Stop the old instance[\s\S]*hatch-server start[\s\S]*Open the URL/);
  assert.match(r.stdout, /Start the per-user instance: {2}hatch-server start\n/, 'default target: plain start');
});

test('migrate: name clash errors and changes nothing; --name picks another; conflicts keep existing settings and are reported', () => {
  const f = fixture(); const home = fs.realpathSync(tmp()); const t = path.join(home, '.hatch');
  // a target that already has things of its own
  w(path.join(t, 'config.json'), { token: 'b'.repeat(32), port: 7070, host: '0.0.0.0', session: 'mine', editor: 'nvim' });
  w(path.join(t, 'commands.json'), [{ name: 'tests', text: 'make test', enter: true }]);
  fs.writeFileSync(path.join(t, 'custom.js'), 'export const mine = 1'); w(path.join(t, 'fx.json'), { effect: 'matrix' });
  w(path.join(t, 'panels', 'p1.json'), { id: 'p1', type: 'terminal', title: 'shell', placement: 'float', props: { name: 'shell' } });
  w(path.join(t, 'workspaces.json'), { version: 1, workspaces: [{ name: 'main', id: 'main' }, { name: 'My-Project', id: 'x1' }] });
  const before = tree(t);
  let r = hatch(['migrate', f.project], { cwd: f.root, home }); assert.equal(r.status, 1); assert.match(r.stderr, /workspace named My-Project.*already exists.*--name NAME/); assert.equal(tree(t), before);
  r = hatch(['migrate', f.project, '--name', 'proj2'], { cwd: f.root, home }); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /conflicts/); assert.match(r.stdout, /commands\.json.*"tests".*kept the existing/); assert.match(r.stdout, /custom\.js differs/); assert.match(r.stdout, /"editor" is "nvim"/); assert.match(r.stdout, /fx\.json differs/);
  assert.equal(rj(path.join(t, 'commands.json')).find((c) => c.name === 'tests').text, 'make test');
  assert.deepEqual(rj(path.join(t, 'commands.json')).map((c) => c.name), ['tests', 'greet']);
  assert.equal(fs.readFileSync(path.join(t, 'custom.js'), 'utf8'), 'export const mine = 1'); assert.equal(fs.readFileSync(path.join(t, 'custom.js.proj2.migrated'), 'utf8'), 'export {}');
  assert.equal(rj(path.join(t, 'config.json')).editor, 'nvim'); assert.equal(rj(path.join(t, 'config.json')).token, 'b'.repeat(32)); assert.equal(rj(path.join(t, 'config.json')).imageSize, '800x550');
  assert.equal(rj(path.join(t, 'fx.json')).effect, 'matrix');
  // the clashing terminal name got the workspace as prefix, the existing window is unchanged
  const names = fs.readdirSync(path.join(t, 'panels')).map((n) => rj(path.join(t, 'panels', n))).filter((p) => p.type === 'terminal').map((p) => p.props.name).sort();
  assert.deepEqual(names, ['proj2-shell', 'shell']);
});

test('migrate with an explicit --state target names it in the next steps; a source that is the target is refused', () => {
  const f = fixture(); const home = fs.realpathSync(tmp()); const target = path.join(tmp(), 'second');
  const r = hatch(['migrate', f.s, '--state', target, '--yes'], { cwd: f.root, home }); assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`hatch-server start --state ${target}`)); assert.equal(fs.existsSync(path.join(home, '.hatch')), false);
  const same = hatch(['migrate', f.s, '--state', f.s], { cwd: f.root, home }); assert.equal(same.status, 1); assert.match(same.stderr, /itself/);
});
