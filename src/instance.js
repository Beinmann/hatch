// Helpers for telling users why a Hatch server cannot be reached.
// Kept apart from find.js so the lookup stays small; nothing here talks to the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `/home/me/proj/.hatch` -> `~/proj/.hatch` (display only). */
export function shortPath(p, home = os.homedir()) {
  if (!home || home === '/') return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The owner record of a state dir (`server.lock` JSON, or `hatch.pid` as a bare number or JSON), read defensively.
 * Returns { pid, port?, alive } or null when absent or unusable. */
export function readOwner(stateDir) {
  for (const name of ['server.lock', 'hatch.pid']) {
    let text; try { text = fs.readFileSync(path.join(stateDir, name), 'utf8'); } catch { continue; }
    let rec = null;
    try { rec = JSON.parse(text); } catch { /* maybe a bare pid */ }
    if (typeof rec === 'number') rec = { pid: rec };
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const pid = Number(rec.pid);
    if (!Number.isInteger(pid) || pid < 1) continue;
    const port = Number.isInteger(rec.port) && rec.port > 0 ? rec.port : undefined;
    return { pid, port, alive: alive(pid) };
  }
  return null;
}

/** The sentence(s) after "cannot reach Hatch ...": where the port came from and what to do next. */
export function unreachableHelp(stateDir, port) {
  const d = shortPath(stateDir);
  const startCmd = shortPath(stateDir) === '~/.hatch' ? '`hatch-server start`' : `\`hatch-server start --state ${d}\``;
  const base = `Port ${port} comes from ${d}/config.json.`;
  const owner = readOwner(stateDir);
  if (owner && owner.alive && owner.port && owner.port !== port) return `${base} The server of that instance runs on port ${owner.port}, so config.json looks wrong: \`hatch-server restart --state ${d}\` rewrites it.`;
  if (owner && owner.alive) return `${base} The server process (pid ${owner.pid}) is running but did not answer; check ${d}/log/server.log.`;
  if (owner) return `${base} The server of that instance is not running: start it with ${startCmd}.`;
  return `${base} If that is the wrong instance, pass --state DIR or set HATCH_STATE; otherwise start it with ${startCmd}.`;
}
