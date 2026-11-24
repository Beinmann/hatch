// Replacing the login token in config.json (read-modify-write: other settings such as viewToken and allowedHosts stay).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './state.js';

export const TOKEN_MAX_AGE_DAYS = 30;
const STAMP = 'token-changed'; // one ISO timestamp; the token itself is never read to make it

/** Writes a fresh 128-bit token (file mode 0600) and returns it; `dropViewToken` also removes the watch-only token (panic). Throws when config.json cannot be read as a JSON object. */
export function rotateTokenFile(stateDir, { dropViewToken = false } = {}) {
  const file = path.join(stateDir, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} must hold a JSON object`);
  const token = crypto.randomBytes(16).toString('hex');
  const next = { ...cfg, token }; if (dropViewToken) delete next.viewToken;
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  touchTokenStamp(stateDir);
  return token;
}

/** Records "the token was changed now" (also what `hatch-server token touch` does after a hand edit). Returns the ISO time. */
export function touchTokenStamp(stateDir, now = Date.now()) {
  const iso = new Date(now).toISOString();
  atomicWrite(path.join(stateDir, STAMP), `${iso}\n`);
  return iso;
}

/** Pure age logic: { changedAt (ms or null), ageDays (whole days or null), stale (older than maxDays) }. Missing or unreadable stamp = unknown, never stale. */
export function tokenAge(text, now = Date.now(), maxDays = TOKEN_MAX_AGE_DAYS) {
  const t = Date.parse(String(text ?? '').trim());
  if (!Number.isFinite(t)) return { changedAt: null, ageDays: null, stale: false };
  const ageDays = Math.max(0, Math.floor((now - t) / 86400000));
  return { changedAt: t, ageDays, stale: ageDays > maxDays };
}

/** Reads the stamp file; the answer holds only times and days. */
export function readTokenAge(stateDir, now = Date.now()) {
  let text = null;
  try { text = fs.readFileSync(path.join(stateDir, STAMP), 'utf8'); } catch { /* unknown */ }
  return tokenAge(text, now);
}
