// One server per state dir. Every server records itself in <state>/server.lock (pid, port, host, process start time) before it binds
// or writes config.json. A second server on the same state dir refuses to start instead of moving to a free port and rewriting
// config.json, which would leave the first instance's clients (`hatch`) pointing at a dead port. The check never reads the port from
// config.json: that is exactly what gets clobbered.
import fs from 'node:fs';
import path from 'node:path';

const lockFile = (state) => path.join(state, 'server.lock');

/** Process start time (clock ticks since boot, /proc/<pid>/stat field 22), or null where /proc is missing. Tells a reused pid from the original. */
export function startTime(pid) {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] || null; } catch { return null; }
}
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Is the lock record's owner still the process that wrote it? Start time decides when both sides have one; otherwise (no /proc record)
 *  the command line must mention hatch-server on Linux; without /proc an alive pid is all there is. */
function ownerLive(rec) {
  if (!rec || !pidAlive(rec.pid) || rec.pid === process.pid) return false; // our own pid in a leftover record is a previous run of ours
  const now = startTime(rec.pid);
  if (rec.start && now) return rec.start === now;
  try { return /hatch-server/.test(fs.readFileSync(`/proc/${rec.pid}/cmdline`, 'utf8')); } catch { return true; }
}
const readLock = (state) => { try { const r = JSON.parse(fs.readFileSync(lockFile(state), 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; } };

/** Servers older than server.lock leave only the daemon's hatch.pid: its pid counts when alive and named hatch-server. */
export function livePidFileOwner(state) {
  let pid; try { pid = Number(fs.readFileSync(path.join(state, 'hatch.pid'), 'utf8').trim()); } catch { return null; }
  if (!pidAlive(pid) || pid === process.pid) return null;
  try { if (!/hatch-server/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) return null; } catch { /* no /proc */ }
  return pid;
}

/** { pid, port } of the live server that owns `state`, or null. Read-only. */
export function liveOwner(state) {
  const rec = readLock(state);
  if (ownerLive(rec)) return { pid: rec.pid, port: rec.port ?? null };
  const pid = livePidFileOwner(state);
  return pid ? { pid, port: null } : null;
}

export class OwnerError extends Error {
  constructor(state, o) {
    super(`a Hatch server (pid ${o.pid}${o.port ? `, port ${o.port}` : ''}) already owns the state dir ${state}; a second one would move to another port and overwrite its config.json, leaving \`hatch\` pointing at a dead port. `
      + `If HATCH_STATE is exported in this shell you are probably inside that instance's terminal. For a separate instance pass its own state dir and port: hatch-server serve --state DIR --port N. `
      + `To replace the running one, stop it first (\`hatch-server stop --state ${state}\` or Ctrl+C where it runs).`);
    this.code = 'EOWNED'; this.owner = o;
  }
}

/** Takes the state dir: exclusive create of server.lock; a stale record (dead pid, reused pid) is replaced. Throws OwnerError when a live
 *  server holds it. Returns { update(fields), release() }; release removes the record only while it is still ours. */
export function acquireLock(state, { host = null, port = null } = {}) {
  fs.mkdirSync(state, { recursive: true });
  const rec = { pid: process.pid, start: startTime(process.pid), host, port };
  const file = lockFile(state);
  for (let attempt = 0; ; attempt++) {
    try { fs.writeFileSync(file, `${JSON.stringify(rec)}\n`, { flag: 'wx', mode: 0o600 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const live = liveOwner(state); if (live) throw new OwnerError(state, live);
      if (attempt > 3) throw new Error(`cannot take ${file}: it keeps reappearing; check for another process starting Hatch on ${state}`);
      fs.rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  const mine = () => { const r = readLock(state); return r && r.pid === process.pid && r.start === rec.start; };
  return {
    update(fields) { Object.assign(rec, fields); if (mine()) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); } },
    release() { if (mine()) fs.rmSync(file, { force: true }); },
  };
}
