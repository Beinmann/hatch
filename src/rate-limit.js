// Failed-login limiter, per client address. A client that fails `max` times in a row is locked out for a while (the lockout doubles with
// every further failure, up to `maxLockMs`) and forgotten after `forgetMs` without failures. Only checks of the long-lived token (login form,
// x-token header, ?t= link, one-time code) go through it; a valid session is never asked, so a lockout cannot lock a logged-in user out.
// Memory is bounded: idle entries are dropped, and past `maxEntries` the oldest entry goes.
import net from 'node:net';

export function createLimiter({ max = 5, baseMs = 30000, maxLockMs = 15 * 60000, forgetMs = 15 * 60000, maxEntries = 5000, now = Date.now } = {}) {
  const entries = new Map(); // key -> { fails, until, last }
  let lastSweep = 0;
  const sweep = () => { const t = now(); if (t - lastSweep < 10000) return; lastSweep = t; for (const [k, e] of entries) if (t - e.last > forgetMs && e.until <= t) entries.delete(k); };
  return {
    /** Milliseconds until `key` may try again, 0 when it may. */
    wait(key) { const e = entries.get(key); return e ? Math.max(0, e.until - now()) : 0; },
    /** Records a failure; returns the lockout it caused in ms (0 when none yet). */
    fail(key) {
      sweep(); const t = now(); let e = entries.get(key);
      if (!e || (t - e.last > forgetMs && e.until <= t)) { e = { fails: 0, until: 0, last: t }; }
      entries.delete(key); // re-inserted last: Map order is then least recently failed first
      e.fails++; e.last = t;
      const lock = e.fails >= max ? Math.min(maxLockMs, baseMs * 2 ** (e.fails - max)) : 0;
      if (lock) e.until = t + lock;
      entries.set(key, e);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return lock;
    },
    success(key) { entries.delete(key); },
    get size() { return entries.size; },
  };
}

const loopback = (a) => a === '127.0.0.1' || a === '::1';
/** The key a request is limited under: its socket address. Behind a reverse proxy on this box every request arrives from loopback, so
 *  there (and only there) the proxy's own X-Forwarded-For entry, the last one, is used; from any other socket it is ignored, since a
 *  client could write anything into it. */
export function clientKey(req) {
  const a = String(req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
  if (!loopback(a)) return a;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return xff && xff.length <= 45 && (net.isIP(xff) || /^[\w.:-]+$/.test(xff)) ? `via-proxy:${xff}` : 'local';
}
