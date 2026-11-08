// Finds a running Hatch from the CLI: --state / HATCH_STATE, then a `.hatch/config.json` found by walking up from
// the cwd, then ~/.hatch/. Reads port and token from config.json and talks to 127.0.0.1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class CliError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }

export function findStateDir({ state, env = process.env, cwd = process.cwd() } = {}) {
  const tryDir = (d) => (d && fs.existsSync(path.join(d, 'config.json')) ? path.resolve(d) : null);
  if (state) { const d = tryDir(state); if (!d) throw new CliError(`no config.json in ${state} (--state): start the server with \`hatch-server serve --state ${state}\``, 2); return d; }
  if (env.HATCH_STATE) { const d = tryDir(env.HATCH_STATE); if (d) return d; }
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const d = tryDir(path.join(dir, '.hatch'));
    if (d) return d;
    if (path.dirname(dir) === dir) break;
  }
  const home = tryDir(path.join(os.homedir(), '.hatch'));
  if (home) return home;
  throw new CliError('cannot find a Hatch state dir (.hatch/config.json). Start the server with `hatch-server serve` in your project, or pass --state DIR.', 2);
}

export function readConfig(stateDir) {
  const file = path.join(stateDir, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new CliError(`cannot read valid JSON from ${file}; repair the file or start Hatch with \`hatch-server serve --state DIR\` to recover it.`, 2); }
  let problem;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) problem = 'configuration must be a JSON object';
  else if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) problem = 'port must be an integer from 1 to 65535';
  else if (typeof cfg.token !== 'string' || !cfg.token || /[\x00-\x20\x7f-\uffff]/.test(cfg.token)) problem = 'token must be non-empty text safe for HTTP headers';
  if (problem) throw new CliError(`invalid ${file}: ${problem}; repair the file or start Hatch with \`hatch-server serve --state DIR\`.`, 2);
  return cfg;
}

/** A tiny client: api(method, path, body) -> parsed JSON; throws CliError(2) when the server cannot be reached. */
export function makeClient(stateDir) {
  const cfg = readConfig(stateDir);
  const base = `http://127.0.0.1:${cfg.port}`;
  return async function api(method, route, body, { raw = false } = {}) {
    let res;
    try {
      res = await fetch(base + route, { method, headers: { 'x-token': cfg.token, ...(body !== undefined && { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    } catch (e) { throw new CliError(`cannot reach Hatch at ${base} (${e.cause?.code || e.message}). Start it with \`hatch-server serve\`.`, 2); }
    const text = await res.text();
    if (!res.ok) { let msg = text; try { msg = JSON.parse(text).error || text; } catch { /* plain text */ } throw new CliError(`${method} ${route}: ${res.status} ${msg}`); }
    if (raw) return text;
    try { return JSON.parse(text); } catch { return text; }
  };
}

/** The server's state dir: --state, HATCH_STATE, else `.hatch/` of the current directory only. It never walks up
 * (a server started in an unrelated folder must not attach to another project's state) and never uses ~/.hatch.
 * Clients (`findStateDir`) still walk up, because they only look for an instance that already runs. */
export function findServerStateDir({ state, env = process.env, cwd = process.cwd() } = {}) {
  if (state || env.HATCH_STATE) return path.resolve(cwd, state || env.HATCH_STATE);
  return path.join(path.resolve(cwd), '.hatch');
}

/** Valid = config.json parses to an object with a usable port and token (the same checks as readConfig). */
export function isValidStateDir(dir) {
  try { readConfig(dir); return true; } catch { return false; }
}
