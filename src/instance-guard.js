// Refuses to start a second server on a state dir that a live one already owns. Without this, the free-port fallback
// would give the newcomer another port and rewrite config.json, and the first server's clients (`hatch`) would then
// point at a port nobody listens on.
import fs from 'node:fs';
import path from 'node:path';

const portOf = (state) => { try { const p = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8')).port; return Number.isInteger(p) ? p : null; } catch { return null; } };

/** The pid in <state>/hatch.pid when it is alive and is a Hatch server (/proc cmdline names hatch-server; without /proc
 *  an alive pid is all we can check). A stale file (process gone, or pid reused by something else) gives null. */
export function livePidFileOwner(state) {
  let pid; try { pid = Number(fs.readFileSync(path.join(state, 'hatch.pid'), 'utf8').trim()); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null; // the daemon writes the child's own pid before it starts serving
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  try { if (!/hatch-server/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) return null; } catch { /* no /proc */ }
  return pid;
}

/** { pid?, port? } of the live server that owns `state`, or null. A foreground server has no pid file, so the port in
 *  config.json is also asked (with the token from the same file) whether a Hatch answers there. */
export async function liveOwner(state) {
  const pid = livePidFileOwner(state); const port = portOf(state);
  if (pid) return { pid, port };
  if (!port) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'x-token': cfg.token }, signal: AbortSignal.timeout(1500) });
    return res.ok ? { pid: null, port } : null;
  } catch { return null; }
}

export const ownerMessage = (state, o) =>
  `a Hatch server${o.pid ? ` (pid ${o.pid})` : ''}${o.port ? ` on port ${o.port}` : ''} already owns the state dir ${state}; starting a second one would overwrite its config.json and leave \`hatch\` pointing at a dead port. `
  + `To run a separate instance use its own state dir and port: hatch-server serve --state DIR --port N (stop the other one with \`hatch-server stop --state ${state}\` or Ctrl+C in its terminal).`;
