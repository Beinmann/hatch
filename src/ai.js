// AI suggestions behind explicit buttons (git commit message, board assistant, palette sentences). Rules for every task:
// the answer is a suggestion the caller shows, never something applied here; Haiku with no tools and a budget cap unless
// config.json says otherwise (`"ai": { "enabled": false, "model": "...", "maxBudgetUsd": 0.05 }`, read per call); text
// (diffs, cards) is sent only because a button was pressed; the Claude limits probe gates calls when the 5-hour window is nearly used.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { runClaude, ClaudeError, DEFAULT_MODEL, DEFAULT_BUDGET_USD } from './claude-p.js';

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

  return { ready, ask, commitMessage };
}
