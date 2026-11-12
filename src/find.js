// Finds the per-user Hatch instance for the CLI and the server: --state, then HATCH_STATE, then ~/.hatch (never the cwd).
// Reads port and token from config.json and talks to 127.0.0.1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unreachableHelp } from './instance.js';

export class CliError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }

/** The per-user default state dir. HOME is read at call time so tests can point it at a temp dir. */
export const defaultStateDir = (env = process.env) => path.join(env.HOME || os.homedir(), '.hatch');

/** Which state dir to use, for the server and for clients alike: --state DIR, then HATCH_STATE, then ~/.hatch.
 * Deliberately no cwd lookup and no walking up: one instance per user. Returns { dir, how: 'flag'|'env'|'default', explicit }.
 * A relative path is taken relative to `cwd`. */
export function chooseStateDir({ state, env = process.env, cwd = process.cwd() } = {}) {
  if (state) return { dir: path.resolve(cwd, state), how: 'flag', explicit: true };
  if (env.HATCH_STATE) return { dir: path.resolve(cwd, env.HATCH_STATE), how: 'env', explicit: true };
  return { dir: defaultStateDir(env), how: 'default', explicit: false };
}

/** The CLI's instance: the chosen dir must already hold a config.json (a server created it), else an error that says how to start one. */
export function resolveStateDir(opts = {}) {
  const c = chooseStateDir(opts);
  if (fs.existsSync(path.join(c.dir, 'config.json'))) return c;
  const src = c.how === 'flag' ? '--state' : c.how === 'env' ? 'HATCH_STATE' : 'default';
  const start = c.how === 'default' ? '`hatch-server start`' : `\`hatch-server serve --state ${c.dir}\``;
  throw new CliError(`no Hatch instance found: ${path.join(c.dir, 'config.json')} does not exist (${src} state dir). Start the server with ${start}${c.how === 'default' ? ' (it creates ~/.hatch the first time)' : ''}, or pass --state DIR. Project-local .hatch dirs are not searched; \`hatch migrate\` moves one into ~/.hatch.`, 2);
}

export const findStateDir = (opts) => resolveStateDir(opts).dir;

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
    } catch (e) { throw new CliError(`cannot reach Hatch at ${base} (${e.cause?.code || e.message}). ${unreachableHelp(stateDir, cfg.port)}`, 2); }
    const text = await res.text();
    if (!res.ok) { let msg = text; try { msg = JSON.parse(text).error || text; } catch { /* plain text */ } throw new CliError(`${method} ${route}: ${res.status} ${msg}`); }
    if (raw) return text;
    try { return JSON.parse(text); } catch { return text; }
  };
}

/** Valid = config.json parses to an object with a usable port and token (the same checks as readConfig). */
export function isValidStateDir(dir) {
  try { readConfig(dir); return true; } catch { return false; }
}
