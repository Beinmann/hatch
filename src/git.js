// Small git helpers for the git panel (Magit-lite): status, stage, unstage, commit. Uses spawn with argument arrays,
// never a shell, so file names cannot inject commands. Commands run at the repository root (paths from status are
// root-relative), with a timeout, and `--literal-pathspecs` so names like `[a].txt` or `*` are not treated as patterns.
import { spawn } from 'node:child_process';

export class GitError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const TIMEOUT_MS = 20000;

/** Parses `git status --porcelain=v1 -z -b`: NUL separated, file names are not quoted, renames list the new name first. */
export function parseStatus(text) {
  const parts = text.split('\0'); let branch = '(unknown)'; let tracking = '';
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i]; if (!l) continue;
    if (l.startsWith('## ')) { const m = /^## (?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(l); if (m) { branch = m[1]; tracking = [m[2], m[3]].filter(Boolean).join(' '); } continue; }
    const x = l[0]; const y = l[1]; const p = l.slice(3);
    if (x === 'R' || x === 'C') i++; // the next entry is the old name
    files.push({ path: p, index: x === ' ' || x === '?' ? '' : x, worktree: y === ' ' ? '' : y, untracked: x === '?', staged: x !== ' ' && x !== '?' });
  }
  return { branch, tracking, files };
}

const checkPaths = (paths) => {
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && p && !p.includes('\0'))) throw new GitError('paths must be a non-empty array of file names');
  return paths;
};

/** Each server owns a client so shutdown can stop its commands without affecting another instance. */
export function createGit({ timeoutMs = TIMEOUT_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) throw new GitError('git timeout must be a positive number of milliseconds within the timer limit');
  const active = new Set(); const queues = new Map(); let closed = false;
  const kill = (child) => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
  function git(dir, args) {
    if (closed) return Promise.reject(new GitError('git client is closed', 503));
    return new Promise((resolve, reject) => {
      let failure = null; let size = 0; const stdout = []; const stderr = [];
      const child = spawn('git', ['--literal-pathspecs', '-C', dir, ...args], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      });
      active.add(child);
      const timer = setTimeout(() => { failure = new GitError(`git took longer than ${timeoutMs / 1000}s (a slow repository or a stuck hook?)`, 504); kill(child); }, timeoutMs);
      const collect = (target) => (chunk) => {
        if (failure) return;
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { failure = new GitError('git printed more than the allowed output', 413); kill(child); }
        else target.push(chunk);
      };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
      child.once('error', (error) => { failure = error.code === 'ENOENT' ? new GitError('git is not installed on this box', 501) : new GitError(error.message); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); active.delete(child);
        if (closed) return reject(new GitError('git command stopped because the server closed', 503));
        if (failure) return reject(failure);
        if (code === 0) return resolve(Buffer.concat(stdout).toString('utf8'));
        const message = Buffer.concat(stderr).toString('utf8').trim() || `git failed${signal ? ` (${signal})` : ''}`;
        reject(new GitError(/not a git repository/i.test(message) ? `not a git repository: ${dir}` : message.split('\n')[0]));
      });
    });
  }
  const root = async (dir) => (await git(dir, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  const statusAt = async (top) => ({ ...parseStatus(await git(top, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=normal'])), root: top });
  const status = async (dir) => statusAt(await root(dir));
  async function mutate(dir, action) {
    const top = await root(dir);
    const operation = (queues.get(top) || Promise.resolve()).catch(() => {}).then(() => action(top));
    queues.set(top, operation);
    try { return await operation; }
    finally { if (queues.get(top) === operation) queues.delete(top); }
  }
  const stage = async (dir, paths) => {
    checkPaths(paths);
    return mutate(dir, async (top) => { await git(top, ['add', '--', ...paths]); return statusAt(top); });
  };
  const unstage = async (dir, paths) => {
    checkPaths(paths);
    return mutate(dir, async (top) => { await git(top, ['reset', '-q', 'HEAD', '--', ...paths]); return statusAt(top); });
  };
  const commit = async (dir, message) => {
    if (typeof message !== 'string' || !message.trim()) throw new GitError('a commit message is needed');
    return mutate(dir, async (top) => {
      if (!(await statusAt(top)).files.some((file) => file.staged)) throw new GitError('nothing is staged');
      await git(top, ['commit', '-m', message]); return statusAt(top);
    });
  };
  return { root, status, stage, unstage, commit, close() { closed = true; for (const child of active) kill(child); } };
}

export const { root, status, stage, unstage, commit } = createGit();
