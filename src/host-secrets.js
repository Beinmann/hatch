// Per-load secrets for hosted pages (`hatch host`). A hosted page runs in a sandbox with an opaque origin, so the browser sends no cookie
// for the page's own css, scripts or images. When the server hands out the page (a request that did carry the login cookie) it makes a
// fresh random secret bound to that page's id; the page's <base href> points at /host-r/SECRET/ID/, and that path serves the folder
// read-only without a cookie. Only hashes are kept, in memory, bounded in number; a secret ends after `idleMs` without use or after
// `maxMs` in all, when the page is un-hosted, or when the token is rotated.
import crypto from 'node:crypto';

export const HOST_SECRET_RE = /^[a-f0-9]{32}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createHostSecrets({ now = Date.now, idleMs = 10 * 60 * 1000, maxMs = 2 * 60 * 60 * 1000, max = 500 } = {}) {
  const map = new Map(); // hash -> { id, idleUntil, hardUntil }
  const sweep = () => { const t = now(); for (const [h, e] of map) if (e.idleUntil <= t || e.hardUntil <= t) map.delete(h); };
  const timer = setInterval(sweep, 60 * 1000); timer.unref();
  return {
    issue(id) {
      sweep(); while (map.size >= max) map.delete(map.keys().next().value); // the oldest goes first
      const secret = crypto.randomBytes(16).toString('hex'); const t = now();
      map.set(sha(secret), { id, idleUntil: t + idleMs, hardUntil: t + maxMs });
      return secret;
    },
    /** True when `secret` is live and was made for page `id`; a use pushes the idle end out (so a page that polls a file keeps working). */
    check(secret, id) {
      if (typeof secret !== 'string' || !HOST_SECRET_RE.test(secret)) return false;
      const h = sha(secret); const e = map.get(h); if (!e) return false;
      const t = now();
      if (e.idleUntil <= t || e.hardUntil <= t) { map.delete(h); return false; }
      if (e.id !== id) return false;
      e.idleUntil = Math.min(t + idleMs, e.hardUntil); return true;
    },
    dropId(id) { for (const [h, e] of map) if (e.id === id) map.delete(h); },
    clear() { map.clear(); },
    close() { clearInterval(timer); },
    get size() { return map.size; },
  };
}
