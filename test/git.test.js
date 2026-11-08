import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseStatus, status, stage, unstage, commit, createGit } from '../src/git.js';
import { startHatch, tmp, waitFor } from './helpers.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const g = (d, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });

test('parseStatus handles branch lines, renames, quoted names and untracked files', () => {
  const s = parseStatus('## main...origin/main [ahead 2]\0 M a.js\0A  b.js\0R  new.js\0old.js\0?? with space.txt\0MM both.js\0');
  assert.equal(s.branch, 'main'); assert.equal(s.tracking, 'origin/main ahead 2');
  assert.deepEqual(s.files.map((f) => f.path), ['a.js', 'b.js', 'new.js', 'with space.txt', 'both.js']);
  assert.equal(s.files[0].staged, false); assert.equal(s.files[1].staged, true); assert.equal(s.files[3].untracked, true); assert.equal(s.files[4].staged && !!s.files[4].worktree, true);
  assert.equal(parseStatus('## No commits yet on main\0').branch, 'main');
});

test('stage, unstage and commit in a real repo; errors are readable', { skip: !hasGit }, async () => {
  const d = tmp(); g(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), '1'); fs.writeFileSync(path.join(d, '--weird name'), '2');
  assert.equal((await status(d)).files.length, 2);
  assert.equal((await stage(d, ['a.txt', '--weird name'])).files.every((f) => f.staged), true, 'dash-leading names are safe');
  assert.equal((await unstage(d, ['a.txt'])).files.find((f) => f.path === 'a.txt').staged, false);
  await assert.rejects(() => commit(d, ''), /message/); await assert.rejects(() => stage(d, []), /paths/);
  const after = (() => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', d, 'commit', '-qm', 'x'], { encoding: 'utf8' }); return r.status; })(); assert.equal(after, 0);
  fs.writeFileSync(path.join(d, 'a.txt'), '3'); await assert.rejects(() => commit(d, 'nothing staged'), /nothing is staged/);
  await assert.rejects(() => status(tmp()), /not a git repository/);
});

test('git API: status, stage and a bad directory', { skip: !hasGit }, async () => {
  const d = tmp(); g(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'x.txt'), 'x');
  const h = await startHatch({ cwd: d });
  try {
    assert.equal((await h.call('GET', '/api/git/status')).data.files[0].path, 'x.txt');
    assert.equal((await h.call('POST', '/api/git/stage', { paths: ['x.txt'] })).data.files[0].staged, true);
    assert.equal((await h.call('POST', '/api/git/stage', { paths: [] })).status, 400);
    assert.equal((await h.call('GET', `/api/git/status?dir=${encodeURIComponent(tmp())}`)).status, 400);
    assert.equal((await h.call('POST', '/api/panels', { type: 'git', props: { dir: d } })).status, 201);
  } finally { await h.close(); }
});

test('slow git hooks leave health and terminal requests responsive', { skip: !hasGit }, async () => {
  const dir = tmp(); g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.name', 'Test User'); g(dir, 'config', 'user.email', 'test@example.test');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'contents'); g(dir, 'add', '.');
  const marker = path.join(dir, 'hook-started'); const release = path.join(dir, 'hook-release');
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch hook-started\nwhile [ ! -e hook-release ]; do sleep 0.05; done\n', { mode: 0o755 });
  const h = await startHatch({ cwd: dir }); let finished = false; let pending;
  try {
    pending = h.call('POST', '/api/git/commit', { message: 'Responsive commit' }).then(result => { finished = true; return result; });
    await waitFor(() => fs.existsSync(marker), 3000);
    assert.equal((await h.call('GET', '/api/health')).status, 200); assert.equal(finished, false);
    assert.equal((await h.call('GET', '/api/term')).status, 200);
    assert.equal((await h.call('POST', '/api/term/input', { data: 'input during git\n' })).status, 200); assert.equal(finished, false);
    fs.writeFileSync(release, 'release'); assert.equal((await pending).status, 200);
  } finally { fs.writeFileSync(release, 'release'); await pending; await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent git mutations serialize and repository roots retain trailing spaces', { skip: !hasGit }, async () => {
  const parent = tmp(); const dir = path.join(parent, 'repository with space '); fs.mkdirSync(dir);
  const client = createGit();
  try {
    g(dir, 'init', '-q', '-b', 'main'); for (const name of ['[a].txt', 'a.txt', '--option']) fs.writeFileSync(path.join(dir, name), name);
    await Promise.all(['[a].txt', 'a.txt', '--option'].map(name => client.stage(dir, [name])));
    const result = await client.status(dir); assert.equal(result.root, dir); assert.equal(result.files.length, 3); assert.ok(result.files.every(file => file.staged));
  } finally { client.close(); fs.rmSync(parent, { recursive: true, force: true }); }
});

test('git timeout stops hook descendants instead of waiting for them to finish', { skip: !hasGit }, async () => {
  const dir = tmp(); const client = createGit({ timeoutMs: 1000 });
  try {
    g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.name', 'Test User'); g(dir, 'config', 'user.email', 'test@example.test');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'contents'); g(dir, 'add', '.');
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch hook-started\nsleep 3\nprintf leaked > hook-finished\n', { mode: 0o755 });
    await assert.rejects(() => client.commit(dir, 'Timeout'), error => error.status === 504);
    assert.ok(fs.existsSync(path.join(dir, 'hook-started')), 'the timeout should exercise an active hook');
    assert.ok(!fs.existsSync(path.join(dir, 'hook-finished')), 'the hook must not finish after git is killed');
  } finally { client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closing a git client stops active hooks and rejects queued mutations', { skip: !hasGit }, async () => {
  const dir = tmp(); const client = createGit();
  try {
    g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.name', 'Test User'); g(dir, 'config', 'user.email', 'test@example.test');
    fs.writeFileSync(path.join(dir, 'file.txt'), 'contents'); g(dir, 'add', '.'); fs.writeFileSync(path.join(dir, 'queued.txt'), 'queued');
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch hook-started\nsleep 5\nprintf leaked > hook-finished\n', { mode: 0o755 });
    const active = assert.rejects(client.commit(dir, 'Closing'), error => error.status === 503);
    await waitFor(() => fs.existsSync(path.join(dir, 'hook-started')), 3000);
    const queued = assert.rejects(client.stage(dir, ['queued.txt']), error => error.status === 503);
    client.close(); await Promise.all([active, queued]);
    await assert.rejects(() => client.status(dir), error => error.status === 503);
    assert.ok(!fs.existsSync(path.join(dir, 'hook-finished')));
    assert.match(g(dir, 'status', '--porcelain').stdout, /\?\? queued.txt/);
  } finally { client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
