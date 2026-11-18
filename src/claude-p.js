// One place that runs `claude -p`: binary lookup (HATCH_CLAUDE overrides), prompt on stdin, model, tools, budget cap,
// timeout and readable errors. Defaults are the cheap, safe ones: Haiku, no tools, a small budget. A call that really needs
// tools or another model says so explicitly (`tools: null` leaves the flag out, `model: null` and `maxBudgetUsd: null` too).
// AI output is only ever a suggestion for the caller to show; nothing here applies it.
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

export const DEFAULT_MODEL = 'haiku';
export const DEFAULT_BUDGET_USD = 0.05;
export const DEFAULT_TIMEOUT_MS = 60000;

export class ClaudeError extends Error {
  constructor(message, code = 'failed') { super(message); this.code = code; }
}

/** The binary to run: HATCH_CLAUDE, else `claude` on PATH. Read per call so tests and users can switch it. */
export const claudeBin = () => process.env.HATCH_CLAUDE || 'claude';

/** Arguments after the binary name. The prompt is not among them: it goes to stdin. */
export function claudeArgs({ model = DEFAULT_MODEL, tools = '', maxBudgetUsd = DEFAULT_BUDGET_USD, extra = [] } = {}) {
  return ['-p', ...(model ? ['--model', model] : []), ...(tools !== null ? ['--tools', tools] : []), ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []), ...extra];
}

const notFound = (bin) => `\`${bin}\` not found on PATH: install Claude Code, or set HATCH_CLAUDE to its path`;
const failure = (bin, code, stderr, stdout) => `${bin} -p failed (exit ${code}): ${String(stderr || stdout || '').trim().split('\n').slice(-3).join(' ') || 'no output'}. Run \`${bin} -p hi\` to check it is logged in.`;

/** Runs `claude -p` once; resolves with stdout (trimmed of nothing), rejects with a ClaudeError that says what to do. */
export function runClaude({ prompt, timeoutMs = DEFAULT_TIMEOUT_MS, cwd = os.tmpdir(), ...opts }) {
  return new Promise((resolve, reject) => {
    const bin = claudeBin(); let out = ''; let err = ''; let child; let settled = false;
    const end = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } end(reject, new ClaudeError(`the Claude CLI did not answer within ${Math.round(timeoutMs / 1000)} s`, 'timeout')); }, timeoutMs);
    try { child = spawn(bin, claudeArgs(opts), { cwd, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return end(reject, new ClaudeError(e.message)); }
    child.on('error', (e) => end(reject, new ClaudeError(e.code === 'ENOENT' ? notFound(bin) : e.message, e.code === 'ENOENT' ? 'missing' : 'failed')));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.stdin.on('error', () => { /* it may exit before reading the prompt (logged out): the exit status says why */ });
    child.stdin.end(prompt ?? '');
    child.on('close', (code) => (code === 0 ? end(resolve, out) : end(reject, new ClaudeError(failure(bin, code, err, out)))));
  });
}

/** Blocking variant for the CLI (`widget generate`): returns stdout or throws a ClaudeError. */
export function runClaudeSync({ prompt, timeoutMs = 300000, cwd, maxBuffer = 16 << 20, ...opts }) {
  const bin = claudeBin();
  const r = spawnSync(bin, claudeArgs(opts), { input: prompt ?? '', encoding: 'utf8', timeout: timeoutMs, maxBuffer, ...(cwd && { cwd }) });
  if (r.error?.code === 'ENOENT') throw new ClaudeError(notFound(bin), 'missing');
  // A provider may exit before reading stdin (for example when logged out): prefer its exit status and stderr.
  if (r.error && !(r.error.code === 'EPIPE' && r.status !== null)) throw new ClaudeError(`could not run ${bin}: ${r.error.message}`);
  if (r.status !== 0) throw new ClaudeError(failure(bin, r.status, r.stderr, r.stdout));
  return r.stdout;
}

/** Pulls a JSON value out of a model reply: the first ```json fence, else the first fence, else the outermost {...}. Returns undefined when none parses. */
export function extractJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(s);
  const tries = [fence?.[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1), s];
  for (const t of tries) { if (!t) continue; try { return JSON.parse(t); } catch { /* next */ } }
  return undefined;
}
