// Helpers for telling users which Hatch instance the CLI picked and why a server cannot be reached.
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
  const base = `Port ${port} comes from ${d}/config.json.`;
  const owner = readOwner(stateDir);
  if (owner && owner.alive && owner.port && owner.port !== port) return `${base} The server of that instance runs on port ${owner.port}, so config.json looks wrong: \`hatch-server restart --state ${d}\` rewrites it.`;
  if (owner && owner.alive) return `${base} The server process (pid ${owner.pid}) is running but did not answer; check ${d}/log/server.log.`;
  if (owner) return `${base} The server of that instance is not running: start it with \`hatch-server serve --state ${d}\`.`;
  return `${base} If that is the wrong instance, pass --state DIR or set HATCH_STATE; otherwise start it with \`hatch-server serve --state ${d}\`.`;
}

/** Prints at most one short line on stderr when the instance choice is surprising (found by walking up, in ~/.hatch,
 * or HATCH_STATE overriding a nearer .hatch). Quiet for --state, a plain HATCH_STATE, pipes, and repeats in the same shell.
 * `resolved` is from resolveStateDir. Returns true when it printed. Stamp dir, pid and streams are injectable for tests. */
export function instanceNotice({ resolved, port, stderr = process.stderr, stdout = process.stdout, stampDir = os.tmpdir(), ppid = process.ppid, user = safeUser(), home } = {}) {
  if (!resolved || !stderr?.isTTY || !stdout?.isTTY) return false;
  const { dir, how, alternatives = [] } = resolved;
  const other = alternatives.find((a) => a.how === 'walk' || a.how === 'home');
  if (!(how === 'walk' || how === 'home' || (how === 'env' && other))) return false;
  const prefix = `hatch-notice-${user}-`;
  cleanStamps(stampDir, prefix);
  const stamp = path.join(stampDir, `${prefix}${ppid}`);
  try { if (fs.readFileSync(stamp, 'utf8') === dir) return false; } catch { /* no stamp yet */ }
  const d = shortPath(dir, home);
  const where = typeof port === 'number' ? `${d} (port ${port})` : d;
  const line = how === 'env'
    ? `hatch: using the instance at ${where} from HATCH_STATE; another one exists at ${shortPath(other.dir, home)}. Switch: --state DIR, or export HATCH_STATE=DIR.`
    : `hatch: using the instance at ${where}. Another one: --state DIR, or export HATCH_STATE=DIR.`;
  stderr.write(`${line}\n`);
  try { fs.writeFileSync(stamp, dir, { mode: 0o600 }); } catch { /* an unwritable temp dir only means the line may repeat */ }
  return true;
}

function safeUser() { try { return os.userInfo().username.replace(/[^\w.-]/g, '_'); } catch { return String(process.getuid?.() ?? 'user'); } }

/** Lazily removes stamps of shells that no longer exist; looks at no more than 200 directory entries. */
function cleanStamps(dir, prefix) {
  let names; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names.slice(0, 200)) {
    if (!n.startsWith(prefix)) continue;
    const pid = Number(n.slice(prefix.length));
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) try { fs.unlinkSync(path.join(dir, n)); } catch { /* raced or not ours */ }
  }
}
