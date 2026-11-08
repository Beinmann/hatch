// Background lifecycle is scoped to the project state directory. A short control lock serializes callers;
// the daemon's tmux session is never killed by stop/restart.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { atomicWrite } from './state.js';

const pidFile = (state) => path.join(state, 'hatch.pid');
const settingsFile = (state) => path.join(state, 'daemon.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try { if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')) return false; } catch { /* no /proc */ }
  return true;
}

/** Validate the executable and state as well as the PID: a stale file must not stop another project. */
export function runningPid(state) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile(state), 'utf8').trim()); } catch { return null; }
  if (!alive(pid)) return null;
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (!/hatch[^/]*$/.test(args[1] || '') || !args.includes('serve')) return null;
    const flag = args.findIndex((a) => a === '--state' || a.startsWith('--state='));
    if (flag < 0) return null;
    const value = args[flag] === '--state' ? args[flag + 1] : args[flag].slice(8);
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (!value || path.resolve(cwd, value) !== path.resolve(state)) return null;
  } catch { /* non-Linux: the alive PID is the available identity check */ }
  return pid;
}

async function controlled(state, action) {
  fs.mkdirSync(state, { recursive: true });
  const file = path.join(state, 'daemon-control.lock');
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, owner); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const text = fs.readFileSync(file, 'utf8'); const pid = Number(text.split(':')[0]);
        // An empty file may belong to a caller between open and write; give that caller time.
        if ((!text && Date.now() - fs.statSync(file).mtimeMs > 10000) || (text && !alive(pid))) {
          if (fs.readFileSync(file, 'utf8') === text) fs.rmSync(file, { force: true });
          continue;
        }
      } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (Date.now() >= deadline) throw new Error('another Hatch lifecycle command is still running; try again shortly');
      await sleep(50);
    }
  }
  try { return await action(); }
  finally { try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); } catch { /* already cleaned */ } }
}

function savedSettings(state) {
  const file = settingsFile(state);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value.args) || !value.args.every((a) => typeof a === 'string') || typeof value.cwd !== 'string') throw new Error('expected args and cwd');
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Migrate a daemon started before startup settings were persisted.
      const pid = runningPid(state);
      if (pid) {
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
          const original = cmdline.slice(cmdline.indexOf('serve') + 1); const args = [];
          for (let i = 0; i < original.length; i++) {
            if (original[i] === '--state') { i++; continue; }
            if (!original[i].startsWith('--state=')) args.push(original[i]);
          }
          return { args, cwd: fs.readlinkSync(`/proc/${pid}/cwd`) };
        } catch { /* platforms without /proc can pass startup options explicitly on first restart */ }
      }
      return { args: [], cwd: process.cwd() };
    }
    throw new Error(`cannot read ${file}: ${e.message}. Repair it or remove it to reset startup options.`);
  }
}

/** Supplied flags replace the matching saved flag; unrelated options (especially --root) survive restart. */
export function mergeOptions(saved, supplied) {
  const key = (arg) => arg.split('=')[0];
  const replaced = new Set(supplied.filter((a) => a.startsWith('--')).map(key));
  const result = [];
  const boolean = new Set(['--view-only', '--tmux-status']);
  for (let i = 0; i < saved.length; i++) {
    const arg = saved[i];
    const takesValue = arg.startsWith('--') && !arg.includes('=') && !boolean.has(arg);
    if (replaced.has(key(arg))) { if (takesValue) i++; continue; }
    result.push(arg); if (takesValue && saved[i + 1] !== undefined) result.push(saved[++i]);
  }
  return [...result, ...supplied];
}

async function stopUnlocked(state) {
  const pid = runningPid(state);
  if (!pid) { fs.rmSync(pidFile(state), { force: true }); return false; }
  if (!fs.existsSync(settingsFile(state))) {
    const settings = savedSettings(state);
    atomicWrite(settingsFile(state), `${JSON.stringify(settings, null, 2)}\n`);
  }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  for (let i = 0; i < 50; i++) { await sleep(100); if (!runningPid(state)) break; }
  if (runningPid(state)) throw new Error(`hatch (pid ${pid}) did not stop within 5 s; inspect the process before stopping it manually`);
  fs.rmSync(pidFile(state), { force: true }); return true;
}

function absolutePaths(args, cwd) {
  const result = [...args];
  for (let i = 0; i < result.length; i++) {
    const match = /^(--cwd|--root)(?:=(.*))?$/.exec(result[i]);
    if (!match) continue;
    if (match[2] !== undefined) result[i] = `${match[1]}=${path.resolve(cwd, match[2])}`;
    else if (result[i + 1] !== undefined) { i++; result[i] = path.resolve(cwd, result[i]); }
  }
  return result;
}

async function startUnlocked(state, exe, supplied) {
  const old = runningPid(state); if (old) return { pid: old, already: true };
  const saved = savedSettings(state); const args = mergeOptions(absolutePaths(saved.args, saved.cwd), absolutePaths(supplied, process.cwd()));
  const cwd = fs.existsSync(saved.cwd) ? saved.cwd : path.dirname(state);
  fs.mkdirSync(path.join(state, 'log'), { recursive: true });
  const logFile = path.join(state, 'log', 'daemon.log');
  const fd = fs.openSync(logFile, 'w', 0o600);
  let child;
  try { child = spawn(process.execPath, [exe, 'serve', '--state', state, '--yes', ...args], { cwd, detached: true, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  let spawnError = null; child.on('error', (e) => { spawnError = e; }); child.unref();
  if (child.pid) fs.writeFileSync(pidFile(state), `${child.pid}\n`, { mode: 0o600 });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    const log = fs.readFileSync(logFile, 'utf8');
    if (!spawnError && /https?:\/\/\S+/.test(log) && runningPid(state) === child.pid) {
      atomicWrite(settingsFile(state), `${JSON.stringify({ args, cwd }, null, 2)}\n`);
      return { pid: child.pid, log };
    }
    if (spawnError || !runningPid(state)) break;
  }
  if (child.pid && alive(child.pid)) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* exited */ } }
  fs.rmSync(pidFile(state), { force: true });
  const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join('\n');
  throw new Error(`hatch did not start. Last output (${logFile}):\n${spawnError?.message || tail || 'no output'}`);
}

export const start = (state, exe, args = []) => controlled(path.resolve(state), () => startUnlocked(path.resolve(state), exe, args));
export const stop = (state) => controlled(path.resolve(state), () => stopUnlocked(path.resolve(state)));
export const restart = (state, exe, args = []) => controlled(path.resolve(state), async () => {
  // Validate saved options before stopping a healthy instance.
  savedSettings(state);
  await stopUnlocked(path.resolve(state)); return startUnlocked(path.resolve(state), exe, args);
});
