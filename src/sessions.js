// Login sessions. The browser cookie holds a random 256-bit session id; only its SHA-256 hash is stored (sessions.json in the state dir,
// mode 0600), so a copy of that file cannot be used to log in. Sessions last 30 days from the login and survive a server restart.
// The server is the only writer while it runs (`hatch-server sessions|logout|rotate-token` talk to it over the API and edit the file
// themselves only when no server runs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './state.js';

export const SESSION_DAYS = 30;
export const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const MAX_SESSIONS = 200; // a bound on the file and the map: the oldest login is dropped first
const SAVE_EVERY_MS = 60 * 1000; // last-seen times are written at most this often
export const SESSION_RE = /^[a-f0-9]{64}$/;
export const hashId = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const clean = (s, n) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n);

export function createSessions({ file, now = Date.now, warn = () => {} }) {
  let map = new Map(); // hash -> { created, lastSeen, expires, hint }
  let dirty = false; let lastSave = 0;
  const load = () => {
    map = new Map();
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') warn(`cannot read ${path.basename(file)}: ${e.message}; everyone has to log in again`); return; }
    try {
      const v = JSON.parse(raw);
      for (const s of Array.isArray(v?.sessions) ? v.sessions : []) {
        if (s && /^[a-f0-9]{64}$/.test(s.hash) && Number.isFinite(s.created) && Number.isFinite(s.expires)) map.set(s.hash, { created: s.created, lastSeen: Number.isFinite(s.lastSeen) ? s.lastSeen : s.created, expires: s.expires, hint: clean(s.hint, 120) });
      }
    } catch (e) { warn(`${path.basename(file)} is not valid JSON (${e.message}); everyone has to log in again. Delete the file to silence this.`); }
  };
  const purge = () => { const t = now(); for (const [h, s] of map) if (s.expires <= t) { map.delete(h); dirty = true; } };
  const save = () => {
    purge();
    try { atomicWrite(file, `${JSON.stringify({ sessions: [...map].map(([hash, s]) => ({ hash, ...s })) }, null, 2)}\n`, { mode: 0o600 }); dirty = false; lastSave = now(); }
    catch (e) { warn(`cannot write ${path.basename(file)}: ${e.message}; logins last until the server restarts`); }
  };
  load(); purge();
  return {
    /** New session; returns the id to put in the cookie (shown once, never stored). */
    create(hint = '') {
      purge();
      while (map.size >= MAX_SESSIONS) map.delete(map.keys().next().value); // Map keeps insertion order: the oldest login
      const id = crypto.randomBytes(32).toString('hex'); const t = now();
      map.set(hashId(id), { created: t, lastSeen: t, expires: t + SESSION_MS, hint: clean(hint, 120) });
      save(); return { id, maxAgeSec: Math.floor(SESSION_MS / 1000) };
    },
    /** True when `id` is a live session; notes the use. Unknown, malformed and expired ids are all just false. */
    check(id) {
      if (typeof id !== 'string' || !SESSION_RE.test(id)) return false;
      const h = hashId(id); const s = map.get(h); if (!s) return false;
      const t = now();
      if (s.expires <= t) { map.delete(h); dirty = true; return false; }
      if (t - s.lastSeen > 1000) { s.lastSeen = t; dirty = true; }
      if (dirty && t - lastSave > SAVE_EVERY_MS) save();
      return true;
    },
    list() { purge(); return [...map].map(([hash, s]) => ({ id: hash.slice(0, 8), ...s })); },
    /** Ends the sessions whose id starts with `prefix` (at least 4 characters, so one typo cannot end the wrong login); returns how many. */
    revoke(prefix) {
      if (typeof prefix !== 'string' || !/^[a-f0-9]{4,64}$/.test(prefix)) throw new Error('session id: at least 4 hex characters, as `hatch-server sessions` shows them');
      const hit = [...map.keys()].filter((h) => h.startsWith(prefix));
      if (hit.length > 1) throw new Error(`${hit.length} sessions start with ${prefix}; give more characters`);
      for (const h of hit) map.delete(h);
      if (hit.length) save(); return hit.length;
    },
    revokeAll() { const n = map.size; map.clear(); save(); return n; },
    flush() { if (dirty) save(); },
    reload: load,
    get size() { return map.size; },
  };
}
