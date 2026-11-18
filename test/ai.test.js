// AI suggestions (commit message, board assistant, palette). The model is never called: HATCH_CLAUDE points at a fake script
// that records its arguments and stdin and prints a canned reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCommand, normalizePlan, promptFor } from '../src/ai-palette.js';
import { startHatch, tmp } from './helpers.js';
import { runClaude, claudeArgs, extractJson, ClaudeError } from '../src/claude-p.js';
import { cleanCommitMessage, readAiSettings, normalizeBoardSuggestion, checkBoardRequest, AiError } from '../src/ai.js';

const GIT_DIR = fileURLToPath(new URL('../examples/widgets/git/', import.meta.url));
const gctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(GIT_DIR, 'parse.js'), 'utf8'), gctx);
const G = gctx.GitParse; const J = (v) => JSON.parse(JSON.stringify(v));
const BOARD_DIR = fileURLToPath(new URL('../examples/widgets/board/', import.meta.url));
const bctx = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(BOARD_DIR, 'model.js'), 'utf8'), bctx);
const M = bctx.ScratchModel;
const gitMeta = JSON.parse(fs.readFileSync(path.join(GIT_DIR, 'widget.json'), 'utf8'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

/** A fake `claude`: logs "args" (one per line) and stdin to <dir>/calls/N.{args,in}, prints the content of <dir>/reply (or exits 1 when <dir>/fail exists). */
export function fakeClaude(reply = 'Add a thing') {
  const dir = fs.realpathSync(tmp()); fs.mkdirSync(path.join(dir, 'calls'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh
d="$(dirname "$0")"; n=$(ls "$d/calls" | wc -l); n=$((n / 2 + 1))
printf '%s\\n' "$@" > "$d/calls/$n.args"; cat > "$d/calls/$n.in"
[ -e "$d/fail" ] && { echo "boom" >&2; exit 1; }
cat "$d/reply"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'reply'), reply);
  const calls = () => fs.readdirSync(path.join(dir, 'calls')).filter((f) => f.endsWith('.args')).length;
  const call = (n = 1) => ({ args: fs.readFileSync(path.join(dir, 'calls', `${n}.args`), 'utf8').split('\n').slice(0, -1), input: fs.readFileSync(path.join(dir, 'calls', `${n}.in`), 'utf8') });
  return { dir, bin, calls, call, setReply: (r) => fs.writeFileSync(path.join(dir, 'reply'), r), fail: () => fs.writeFileSync(path.join(dir, 'fail'), '') };
}
export async function withFake(fake, fn) {
  const old = process.env.HATCH_CLAUDE; process.env.HATCH_CLAUDE = fake.bin;
  try { return await fn(); } finally { if (old === undefined) delete process.env.HATCH_CLAUDE; else process.env.HATCH_CLAUDE = old; }
}
const okLimits = async () => ({ fiveHour: { label: '5-hour', percent: 10, resetsAt: null } });

function repo() {
  const d = fs.realpathSync(tmp()); git(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), '1\n'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'Add a');
  return d;
}

test('claude-p: safe defaults (haiku, no tools, budget), prompt on stdin, HATCH_CLAUDE, readable errors', async () => {
  assert.deepEqual(claudeArgs(), ['-p', '--model', 'haiku', '--tools', '', '--max-budget-usd', '0.05']);
  assert.deepEqual(claudeArgs({ model: null, tools: null, maxBudgetUsd: null }), ['-p'], 'generate keeps the bare form');
  const f = fakeClaude('hello');
  await withFake(f, async () => {
    assert.equal(await runClaude({ prompt: 'the prompt' }), 'hello');
    assert.deepEqual(f.call().args, ['-p', '--model', 'haiku', '--tools', '', '--max-budget-usd', '0.05']); assert.equal(f.call().input, 'the prompt');
    f.fail(); await assert.rejects(runClaude({ prompt: 'x' }), (e) => e instanceof ClaudeError && /failed \(exit 1\).*boom/.test(e.message));
  });
  const old = process.env.HATCH_CLAUDE; process.env.HATCH_CLAUDE = path.join(f.dir, 'nope');
  try { await assert.rejects(runClaude({ prompt: 'x' }), (e) => e.code === 'missing' && /not found on PATH.*HATCH_CLAUDE/.test(e.message)); } finally { if (old === undefined) delete process.env.HATCH_CLAUDE; else process.env.HATCH_CLAUDE = old; }
  const slow = fakeClaude(); fs.writeFileSync(slow.bin, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  await withFake(slow, () => assert.rejects(runClaude({ prompt: 'x', timeoutMs: 200 }), (e) => e.code === 'timeout'));
});

test('extractJson: fenced, bare and garbage replies', () => {
  assert.deepEqual(extractJson('here:\n```json\n{"a":1}\n```\nbye'), { a: 1 });
  assert.deepEqual(extractJson('sure {"a":2} done'), { a: 2 });
  assert.equal(extractJson('no json'), undefined);
});

test('cleanCommitMessage and settings: one clean line, safe fallbacks', () => {
  assert.equal(cleanCommitMessage('```\nCommit message: "Fix the parser."\n```\nbecause...'), 'Fix the parser');
  assert.equal(cleanCommitMessage('  \n'), '');
  const f = path.join(tmp(), 'config.json');
  assert.deepEqual(readAiSettings(f), { enabled: true, model: 'haiku', maxBudgetUsd: 0.05 });
  fs.writeFileSync(f, JSON.stringify({ ai: { enabled: false, model: 'bad model!', maxBudgetUsd: 99 } }));
  assert.deepEqual(readAiSettings(f), { enabled: false, model: 'haiku', maxBudgetUsd: 0.05 });
  fs.writeFileSync(f, JSON.stringify({ ai: { model: 'sonnet', maxBudgetUsd: 0.2 } }));
  assert.deepEqual(readAiSettings(f), { enabled: true, model: 'sonnet', maxBudgetUsd: 0.2 });
});

test('commit-message: staged diff and recent subjects go to the model; the reply is returned, nothing is committed', async () => {
  const d = repo(); const f = fakeClaude('Update a.txt to two.\n\nLonger explanation that is dropped');
  const h = await startHatch({ cwd: d, limitsProbe: okLimits });
  try {
    await withFake(f, async () => {
      assert.equal((await h.call('POST', '/api/ai/commit-message', {})).status, 400, 'no changes: nothing to describe, no model call');
      assert.equal(f.calls(), 0);
      fs.writeFileSync(path.join(d, 'a.txt'), 'two\n');
      let r = await h.call('POST', '/api/ai/commit-message', {});
      assert.equal(r.status, 200); assert.deepEqual(r.data, { message: 'Update a.txt to two', source: 'unstaged', truncated: false });
      const c = f.call(1); assert.deepEqual(c.args.slice(0, 7), ['-p', '--model', 'haiku', '--tools', '', '--max-budget-usd', '0.05']);
      assert.match(c.input, /\+two/); assert.match(c.input, /Add a/); assert.match(c.input, /private information/);
      git(d, 'add', 'a.txt'); fs.writeFileSync(path.join(d, 'a.txt'), 'three\n');   // staged wins over unstaged
      r = await h.call('POST', '/api/ai/commit-message', {}); assert.equal(r.data.source, 'staged');
      assert.match(f.call(2).input, /\+two/); assert.doesNotMatch(f.call(2).input, /\+three/);
      assert.equal(git(d, 'log', '--format=%s').trim(), 'Add a', 'suggesting never commits');
      // a huge diff is cut and says so
      fs.writeFileSync(path.join(d, 'a.txt'), 'x'.repeat(60000) + '\n'); git(d, 'add', 'a.txt');
      r = await h.call('POST', '/api/ai/commit-message', {}); assert.equal(r.data.truncated, true); assert.ok(f.call(3).input.length < 42000);
      // failures: one-line errors, nothing else changes
      f.fail(); r = await h.call('POST', '/api/ai/commit-message', {}); assert.equal(r.status, 502); assert.match(r.data.error, /boom/);
    });
    process.env.HATCH_CLAUDE = path.join(f.dir, 'nope');
    try { const r = await h.call('POST', '/api/ai/commit-message', {}); assert.equal(r.status, 424); assert.match(r.data.error, /not found/); } finally { delete process.env.HATCH_CLAUDE; }
    assert.equal((await h.call('POST', '/api/ai/nothing', {})).status, 404);
  } finally { await h.close(); }
});

test('AI gating: off switch, limits gate and view-only links all refuse before any model call', async () => {
  const d = repo(); fs.writeFileSync(path.join(d, 'a.txt'), 'two\n'); const f = fakeClaude('Msg');
  let percent = 99;
  const h = await startHatch({ cwd: d, limitsProbe: async () => ({ fiveHour: { label: '5-hour', percent, resetsAt: null } }) });
  try {
    await withFake(f, async () => {
      let r = await h.call('POST', '/api/ai/commit-message', {}); assert.equal(r.status, 429); assert.match(r.data.error, /5-hour limit is 99%/);
      assert.equal(f.calls(), 0);
      const cfg = path.join(h.stateDir, 'config.json'); const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      fs.writeFileSync(cfg, JSON.stringify({ ...c, ai: { enabled: false } }));
      r = await h.call('POST', '/api/ai/commit-message', {}); assert.equal(r.status, 403); assert.match(r.data.error, /switched off/);
      fs.writeFileSync(cfg, JSON.stringify({ ...c, viewToken: 'viewer-token-for-ai-check' }));
      const view = await fetch(`${h.base}/api/ai/commit-message`, { method: 'POST', headers: { 'x-token': 'viewer-token-for-ai-check', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(view.status, 403);
      assert.equal(f.calls(), 0);
    });
  } finally { await h.close(); }
});

test('git widget: suggest and commit-with helpers, the commit-with source commits only the staged changes with the given message', async () => {
  assert.ok(gitMeta.ai.includes('commit-message'));
  const v = (o) => J(G.msgView(o));
  assert.equal(v({ staged: 0, dirty: true, text: 'x' }).commit.disabled, true, 'nothing staged');
  assert.equal(v({ staged: 1, dirty: true, text: '  ' }).commit.disabled, true, 'empty message');
  assert.equal(v({ staged: 1, dirty: true, text: 'ok' }).commit.disabled, false);
  assert.equal(v({ staged: 1, dirty: false, text: 'ok', busy: 'suggest' }).suggest.disabled, true);
  assert.equal(v({ staged: 0, dirty: false, text: '' }).suggest.disabled, true, 'clean tree');
  assert.equal(G.suggestNote({ message: ' a  b ', source: 'staged' }).message, 'a b');
  assert.equal(G.suggestNote({}).ok, false);
  const d = repo(); fs.writeFileSync(path.join(d, 'a.txt'), 'two\n'); fs.writeFileSync(path.join(d, 'b.txt'), 'b\n'); git(d, 'add', 'a.txt');
  const src = gitMeta.sources.find((s) => s.name === 'commit-with');
  const run = (arg, dir = d) => { try { return { out: execFileSync('/bin/sh', ['-c', src.cmd.replaceAll('{{cwd}}', `'${dir}'`)], { encoding: 'utf8', env: { ...process.env, HATCH_ARG: arg } }), code: 0 }; } catch (e) { return { out: e.stdout, code: e.status }; } };
  const ok = run('Change a "quoted" $HOME `x`'); assert.equal(G.parseCommitWith({ out: ok.out.trim(), code: ok.code }).ok, true);
  assert.equal(git(d, 'log', '-n1', '--format=%s').trim(), 'Change a "quoted" $HOME `x`');
  assert.equal(git(d, 'status', '--porcelain').trim(), '?? b.txt', 'unstaged and untracked files are left alone');
  const again = run('nothing staged'); assert.equal(G.parseCommitWith({ out: again.out.trim(), code: 0 }).ok, false);
  assert.equal(G.parseCommitWith({ out: run('x', path.join(d, 'missing')).out.trim() }).ok, false);
});

// ---- board assistant ----
const sel = [{ id: 'c1', type: 'task', text: 'Write the parser' }, { id: 'c2', text: 'Test it' }];
const expandReply = '```json\n' + JSON.stringify({ cards: [{ ref: 'n1', type: 'task', text: 'Handle errors' }, { ref: 'n2', type: 'bogus', text: 'Docs' }, { ref: 'c1', text: 'clashes with a selected id' }, { ref: 'n3', text: '  ' }, { ref: 'n1', text: 'duplicate ref' }],
  arrows: [{ from: 'c1', to: 'n1' }, { from: 'n1', to: 'n2' }, { from: 'n1', to: 'zzz' }, { from: 'c2', to: 'c2' }, { from: 'c1', to: 'n1' }] }) + '\n```';

test('board suggestions: bad types become notes, clashing refs, empty text, unknown or duplicate arrows are dropped and counted', () => {
  const r = normalizeBoardSuggestion('expand', JSON.parse(expandReply.replace(/```(json)?/g, '')), ['c1', 'c2']);
  assert.deepEqual(r.cards, [{ ref: 'n1', type: 'task', text: 'Handle errors' }, { ref: 'n2', type: 'note', text: 'Docs' }]);
  assert.deepEqual(r.arrows, [{ from: 'c1', to: 'n1' }, { from: 'n1', to: 'n2' }]);
  assert.equal(r.dropped, 6);
  assert.throws(() => normalizeBoardSuggestion('expand', { cards: [] }, ['c1']), AiError);
  assert.deepEqual(normalizeBoardSuggestion('summarise', { text: ' Short ' }, ['c1']).cards, [{ ref: 'n1', type: 'note', text: 'Short' }]);
  assert.equal(normalizeBoardSuggestion('group', { title: 'Parser work\nextra' }, ['c1']).title, 'Parser work');
  assert.throws(() => normalizeBoardSuggestion('group', {}, ['c1']), AiError);
  assert.throws(() => checkBoardRequest({ action: 'delete', cards: sel }), /action must be/);
  assert.throws(() => checkBoardRequest({ action: 'expand', cards: [] }), /select at least one/);
  assert.throws(() => checkBoardRequest({ action: 'expand', cards: [{ id: '../x', text: '' }] }), /unique id/);
  assert.throws(() => checkBoardRequest({ action: 'expand', cards: Array.from({ length: 31 }, (_, i) => ({ id: `c${i}`, text: '' })) }), /at most 30/);
});

test('board model: aiSlice sends only the selection; applySuggestion adds cards and arrows as one board value without touching the rest', () => {
  let b = J(M.addCard(M.empty(), 100, 100, 'one')).board; const o = J(M.addCard(b, 400, 100, 'two')); b = o.board;
  b = J(M.addCard(b, 700, 100, 'secret other card')).board;
  const slice = J(M.aiSlice(b, ['c1', 'c2']));
  assert.deepEqual(slice.cards.map((c) => c.id), ['c1', 'c2']); assert.ok(!JSON.stringify(slice).includes('secret')); assert.equal(slice.cards[0].type, 'note');
  const s = { cards: [{ ref: 'n1', type: 'task', text: 'Next' }, { ref: 'n2', type: 'board', text: 'not allowed type' }, { ref: 'n3', type: 'note', text: '' }], arrows: [{ from: 'c1', to: 'n1' }, { from: 'n1', to: 'gone' }, { from: 'c2', to: 'n2' }] };
  const r = J(M.applySuggestion(b, ['c1', 'c2'], s));
  assert.equal(r.board.cards.length, 5); assert.equal(r.ids.length, 2);
  const [n1, n2] = r.board.cards.slice(3);
  assert.equal(n1.type, 'task'); assert.equal(n2.type, undefined, 'a type the model may not create becomes a note');
  assert.ok(n1.x >= 310 + 180 + 60, 'new cards start right of the selection'); assert.ok(n2.y > n1.y);
  assert.deepEqual(r.board.arrows.map((a) => [a.from, a.to]), [['c1', n1.id], ['c2', n2.id]]);
  assert.deepEqual(r.board.cards.slice(0, 3), b.cards, 'existing cards are untouched');
  assert.ok(r.board.nextId > Math.max(...r.board.cards.map((c) => parseInt(c.id.slice(1), 10))));
  // the original board object is never mutated, so one history snapshot is one undo step
  assert.equal(b.cards.length, 3);
  const h = J(M.historyPush(M.historyNew(), b)); assert.deepEqual(J(M.historyUndo(h, r.board)).board.cards, b.cards);
});

test('board: /api/ai/board sends only the selection to the fake model, returns a validated suggestion and applies nothing', async () => {
  const f = fakeClaude(expandReply);
  const h = await startHatch({ limitsProbe: okLimits });
  try {
    await withFake(f, async () => {
      const r = await h.call('POST', '/api/ai/board', { action: 'expand', cards: sel, arrows: [{ from: 'c1', to: 'c2' }, { from: 'c1', to: 'c9' }] });
      assert.equal(r.status, 200); assert.equal(r.data.cards.length, 2); assert.equal(r.data.arrows.length, 2); assert.equal(r.data.dropped, 6);
      const c = f.call(1); assert.deepEqual(c.args.slice(0, 7), ['-p', '--model', 'haiku', '--tools', '', '--max-budget-usd', '0.05']);
      assert.match(c.input, /Write the parser/); assert.match(c.input, /"from":"c1","to":"c2"/); assert.doesNotMatch(c.input, /c9/);
      f.setReply('```json\n{"title":"Parser"}\n```'); const g = await h.call('POST', '/api/ai/board', { action: 'group', cards: sel });
      assert.deepEqual(g.data, { action: 'group', title: 'Parser', cards: [], arrows: [], dropped: 0 });
      f.setReply('I cannot do that'); assert.equal((await h.call('POST', '/api/ai/board', { action: 'summarise', cards: sel })).status, 502);
      const before = f.calls();
      assert.equal((await h.call('POST', '/api/ai/board', { action: 'expand', cards: [] })).status, 400);
      assert.equal(f.calls(), before, 'an invalid request never reaches the model');
    });
  } finally { await h.close(); }
});

// ---- natural-language palette ----
test('palette validation: only allowlisted hatch commands, no code-running flags, no shell syntax needed', () => {
  assert.deepEqual(validateCommand(['widget', 'open', 'git']), { ok: true, argv: ['widget', 'open', 'git'], text: 'hatch widget open git' });
  assert.equal(validateCommand(['hatch', 'fx', 'rain', '--intensity', '30']).text, 'hatch fx rain --intensity 30', 'a leading hatch is tolerated');
  assert.equal(validateCommand(['note', 'it\'s; rm -rf x']).text, "hatch note 'it'\\''s; rm -rf x'", 'text is quoted for display only; it is never run through a shell');
  for (const bad of [['run', 'rm -rf /'], ['rm', '-rf', '/'], ['widget', 'rm', 'git'], ['widget', 'generate', 'x'], ['widget'], ['every', '5m', 'x'], ['term', 'a', '--cmd', 'x'], ['tasks', '--run', 'x'], ['host', 'a.html'], ['set', 'background', 'x.png'],
    ['note', 'x', '--yes'], ['open', 'x', '--state', '/tmp/other'], ['workspace', 'close', 'a'], ['progress', 'set', '-'], [], 'widget open git', ['note', 'a\0b'], ['note', 5], ['fx', ...Array(40).fill('a')]]) {
    assert.equal(validateCommand(bad).ok, false, JSON.stringify(bad));
  }
  const p = normalizePlan({ say: 'ok', commands: [['widget', 'open', 'git'], ['run', 'whoami'], ['fx', 'off'], 'nonsense', ...Array(8).fill(['panels'])] });
  assert.deepEqual(p.commands.slice(0, 2).map((c) => c.text), ['hatch widget open git', 'hatch fx off']); assert.equal(p.commands.length, 6);
  assert.match(p.rejected[0].reason, /not a command the palette may run/); assert.ok(p.rejected.length >= 4);
  assert.throws(() => normalizePlan({}), /did not return a command list/);
  assert.match(promptFor('close all', '/work/dir'), /\/work\/dir/);
});

test('palette: /api/ai/palette plans with the fake model (nothing runs); /api/ai/palette-run re-validates and runs approved commands without a shell', async () => {
  const f = fakeClaude('```json\n{"say":"Opens git and a note","commands":[["widget","open","git"],["run","whoami"],["note","hello from the palette","--title","Hi"]]}\n```');
  const h = await startHatch({ limitsProbe: okLimits });
  try {
    await withFake(f, async () => {
      const r = await h.call('POST', '/api/ai/palette', { text: 'open git and a note' });
      assert.equal(r.status, 200); assert.equal(r.data.say, 'Opens git and a note');
      assert.deepEqual(r.data.commands.map((c) => c.text), ['hatch widget open git', "hatch note 'hello from the palette' --title Hi"]);
      assert.equal(r.data.rejected.length, 1); assert.match(r.data.rejected[0].reason, /run/);
      assert.match(f.call(1).input, /open git and a note/); assert.deepEqual(f.call(1).args.slice(0, 5), ['-p', '--model', 'haiku', '--tools', '']);
      assert.equal((await h.call('GET', '/api/panels')).data.length, 0, 'planning changes nothing');
      assert.equal((await h.call('POST', '/api/ai/palette', { text: '' })).status, 400);
      assert.equal((await h.call('POST', '/api/ai/palette', { text: 'x'.repeat(501) })).status, 400);
      f.setReply('no json here'); assert.equal((await h.call('POST', '/api/ai/palette', { text: 'x' })).status, 502);
    });
    // the page sends back only what the user confirmed; the server still refuses anything off the list
    const bad = await h.call('POST', '/api/ai/palette-run', { commands: [['note', 'x'], ['run', 'touch /tmp/hatch-should-not-exist']] });
    assert.equal(bad.status, 403); assert.match(bad.data.error, /refused/); assert.equal((await h.call('GET', '/api/panels')).data.length, 0, 'one bad command stops the whole batch');
    assert.equal((await h.call('POST', '/api/ai/palette-run', { commands: [] })).status, 400);
    const ok = await h.call('POST', '/api/ai/palette-run', { commands: [['note', 'hello from the palette', '--title', 'Hi']] });
    assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.results[0].code, 0);
    const panels = (await h.call('GET', '/api/panels')).data; assert.equal(panels.length, 1); assert.equal(panels[0].type, 'note');
    const fail = await h.call('POST', '/api/ai/palette-run', { commands: [['close', 'no-such-window'], ['note', 'never runs']] });
    assert.equal(fail.data.results.length, 1, 'stops at the first failure'); assert.notEqual(fail.data.results[0].code, 0);
  } finally { await h.close(); }
});
