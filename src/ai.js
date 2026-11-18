// AI suggestions behind explicit buttons (git commit message, board assistant, palette sentences). Rules for every task:
// the answer is a suggestion the caller shows, never something applied here; Haiku with no tools and a budget cap unless
// config.json says otherwise (`"ai": { "enabled": false, "model": "...", "maxBudgetUsd": 0.05 }`, read per call); text
// (diffs, cards) is sent only because a button was pressed; the Claude limits probe gates calls when the 5-hour window is nearly used.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { runClaude, ClaudeError, extractJson, DEFAULT_MODEL, DEFAULT_BUDGET_USD } from './claude-p.js';

export class AiError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export const LIMIT_BLOCK_PERCENT = 95;   // refuse new AI calls at or above this 5-hour utilization
export const DIFF_MAX = 40000;           // bytes of diff sent to the model, like the git widget's own cap

/** Settings from the `ai` object of config.json; anything missing or malformed falls back to the safe default. */
export function readAiSettings(configFile) {
  let ai = {};
  try { const c = JSON.parse(fs.readFileSync(configFile, 'utf8')).ai; if (c && typeof c === 'object') ai = c; } catch { /* no file yet */ }
  return {
    enabled: ai.enabled !== false,
    model: typeof ai.model === 'string' && /^[\w.\[\]-]{1,60}$/.test(ai.model) ? ai.model : DEFAULT_MODEL,
    maxBudgetUsd: Number.isFinite(ai.maxBudgetUsd) && ai.maxBudgetUsd > 0 && ai.maxBudgetUsd <= 5 ? ai.maxBudgetUsd : DEFAULT_BUDGET_USD,
  };
}

const git = (cwd, args) => new Promise((resolve) => {
  execFile('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-C', cwd, ...args], { maxBuffer: 8 << 20, timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }));
});

/** Keeps the first `max` bytes (cut on a character boundary). */
const cut = (s, max) => { const b = Buffer.from(s); return b.length <= max ? { text: s, truncated: false } : { text: b.subarray(0, max).toString('utf8').replace(/�$/, ''), truncated: true }; };

/** A model reply -> one clean subject line: first non-empty line, quotes, fences, "Commit message:" labels and trailing dots removed. */
export function cleanCommitMessage(reply) {
  const lines = String(reply || '').replace(/```[a-z]*/gi, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let line = (lines[0] || '').replace(/^(commit message|message|subject)\s*:\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  line = line.replace(/\.+$/, '');
  return line.slice(0, 200);
}

// ---- board assistant: the model proposes new cards and arrows for a selection; positions are left out (the widget places them) ----
export const BOARD_ACTIONS = ['expand', 'summarise', 'group'];
export const BOARD_NEW_TYPES = ['note', 'task', 'code', 'milestone', 'quote'];   // types a suggestion may create (board, group and link need more than text)
const BOARD_LIMITS = { cards: 30, text: 2000, newCards: 12 };
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Validates the client's selection slice: { action, cards: [{id, type?, text}], arrows: [{from, to}] } or throws AiError(400). */
export function checkBoardRequest(b) {
  if (!b || typeof b !== 'object' || !BOARD_ACTIONS.includes(b.action)) throw new AiError(`action must be one of: ${BOARD_ACTIONS.join(', ')}`);
  if (!Array.isArray(b.cards) || !b.cards.length) throw new AiError('select at least one card first');
  if (b.cards.length > BOARD_LIMITS.cards) throw new AiError(`select at most ${BOARD_LIMITS.cards} cards (the selection is all that is sent)`);
  const ids = new Set(); const cards = [];
  for (const c of b.cards) {
    if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || ids.has(c.id)) throw new AiError('every selected card needs a unique id');
    ids.add(c.id); cards.push({ id: c.id, type: typeof c.type === 'string' && /^[a-z]{1,12}$/.test(c.type) ? c.type : 'note', text: typeof c.text === 'string' ? c.text.slice(0, BOARD_LIMITS.text) : '' });
  }
  const arrows = (Array.isArray(b.arrows) ? b.arrows : []).filter((a) => a && ids.has(a.from) && ids.has(a.to) && a.from !== a.to).slice(0, 100).map((a) => ({ from: a.from, to: a.to }));
  return { action: b.action, cards, arrows };
}

/** A model reply (parsed JSON) -> { action, cards: [{ref, type, text}], arrows: [{from, to}], title?, dropped }.
 *  Anything invalid is dropped and counted: bad types become notes, refs that clash with existing ids or each other, arrows
 *  to unknown ids, self loops and duplicates, empty text. Throws AiError(502) when nothing usable is left. */
export function normalizeBoardSuggestion(action, parsed, ids) {
  const known = new Set(ids); let dropped = 0;
  const strip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  if (action === 'group') {
    const title = strip(parsed?.title, 80).split('\n')[0];
    if (!title) throw new AiError('The model returned no title for the group. Try again.', 502);
    return { action, title, cards: [], arrows: [], dropped: 0 };
  }
  const raw = action === 'summarise' ? (parsed && typeof parsed.text === 'string' ? [{ ref: 'n1', type: 'note', text: parsed.text }] : []) : (Array.isArray(parsed?.cards) ? parsed.cards : []);
  const cards = []; const refs = new Set();
  for (const c of raw) {
    const text = strip(c?.text, BOARD_LIMITS.text); const ref = typeof c?.ref === 'string' ? c.ref : '';
    if (!text || !ID_RE.test(ref) || known.has(ref) || refs.has(ref) || cards.length >= BOARD_LIMITS.newCards) { dropped++; continue; }
    refs.add(ref); cards.push({ ref, type: BOARD_NEW_TYPES.includes(c.type) ? c.type : 'note', text });
  }
  if (!cards.length) throw new AiError('The model returned no usable cards. Try again, or select different cards.', 502);
  const seen = new Set(); const arrows = [];
  for (const a of action === 'summarise' ? [] : Array.isArray(parsed?.arrows) ? parsed.arrows : []) {
    const ok = a && (known.has(a.from) || refs.has(a.from)) && (known.has(a.to) || refs.has(a.to)) && a.from !== a.to && !seen.has(`${a.from}>${a.to}`);
    if (!ok) { dropped++; continue; }
    seen.add(`${a.from}>${a.to}`); arrows.push({ from: a.from, to: a.to });
  }
  return { action, cards, arrows, dropped };
}

export function createAi({ configFile, cwd, limits, run = runClaude }) {
  /** Shared checks before any call: the off switch and the limits gate. Returns the settings. */
  async function ready() {
    const s = readAiSettings(configFile);
    if (!s.enabled) throw new AiError('AI features are switched off (config.json: "ai": { "enabled": false }). Remove that line or set it to true to use them.', 403);
    let five = null;
    try { five = (await limits.get())?.claude?.fiveHour?.percent ?? null; } catch { /* an unreadable probe never blocks */ }
    if (typeof five === 'number' && five >= LIMIT_BLOCK_PERCENT) throw new AiError(`The Claude 5-hour limit is ${Math.round(five)}% used; AI suggestions are paused until it resets (see the limits indicator).`, 429);
    return s;
  }
  /** One model call; Claude errors become AiError with the helper's readable message. */
  async function ask(prompt, s, extra = {}) {
    try { return await run({ prompt, model: s.model, maxBudgetUsd: s.maxBudgetUsd, ...extra }); } catch (e) { if (e instanceof ClaudeError) throw new AiError(e.message, e.code === 'missing' ? 424 : 502); throw e; }
  }

  /** Suggests a one-line commit message for the staged changes (or the unstaged ones when nothing is staged). */
  async function commitMessage() {
    const s = await ready();
    if (!(await git(cwd, ['rev-parse', '--show-toplevel'])).ok) throw new AiError('The server folder is not inside a git repository.');
    let source = 'staged'; let d = await git(cwd, ['diff', '--cached', '--no-ext-diff', '--no-textconv']);
    if (!d.out.trim()) { source = 'unstaged'; d = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv']); }
    if (!d.out.trim()) throw new AiError('Nothing to describe: no staged or unstaged changes (untracked files are not included).');
    const { text: diff, truncated } = cut(d.out, DIFF_MAX);
    const recent = (await git(cwd, ['log', '-n', '10', '--format=%s'])).out.trim();
    const prompt = [
      'Write a git commit message for the changes below.',
      'Rules: reply with ONE line only (imperative mood, at most 72 characters), in the style of the recent commit subjects. No quotes, no explanation, no trailing period.',
      'Leave out private information: secrets, tokens, hostnames, usernames, emails, absolute home paths, private project names, ticket numbers.',
      '', 'Recent commit subjects:', recent || '(none yet)', '', `Diff (${source}${truncated ? `, cut after ${DIFF_MAX} bytes` : ''}):`, diff,
    ].join('\n');
    const message = cleanCommitMessage(await ask(prompt, s));
    if (!message) throw new AiError('The model returned no message. Try again.', 502);
    return { message, source, truncated };
  }

  /** Expand, summarise or group the selected cards. Only the selection slice (ids, types, texts, arrows between them) is sent. */
  async function board(body) {
    const s = await ready();
    const req = checkBoardRequest(body);
    const how = {
      expand: 'Suggest up to 6 follow-up cards that build on the selected cards (next steps, missing pieces, questions), and arrows that connect them to the selected cards or to each other. Reply with JSON: {"cards":[{"ref":"n1","type":"note|task|milestone|code|quote","text":"..."}],"arrows":[{"from":"<selected id or ref>","to":"<selected id or ref>"}]}. Use refs n1, n2, ... for new cards; never reuse a selected id as a ref.',
      summarise: 'Summarise the selected cards in one short card (at most 60 words, plain text, keep checklist lines out). Reply with JSON: {"text":"..."}.',
      group: 'Give the selected cards one short title (at most 5 words) that says what they have in common. Reply with JSON: {"title":"..."}.',
    }[req.action];
    const prompt = [
      'You help with a visual board of cards (sticky notes, tasks, milestones, code snippets, quotes). Card text may contain markdown and checklist lines "- [ ] item".',
      how, 'Reply with the JSON only, no explanation. Do not include positions. Do not repeat private information such as secrets or absolute home paths.',
      '', 'Selected cards:', JSON.stringify(req.cards), 'Arrows between them:', JSON.stringify(req.arrows),
    ].join('\n');
    const parsed = extractJson(await ask(prompt, s));
    if (parsed === undefined) throw new AiError('The model did not return JSON. Try again.', 502);
    return normalizeBoardSuggestion(req.action, parsed, req.cards.map((c) => c.id));
  }

  return { ready, ask, commitMessage, board };
}
