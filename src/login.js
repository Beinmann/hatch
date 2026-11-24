// The login page and the one-time login codes.
import crypto from 'node:crypto';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** The login form. No script: the page CSP forbids inline script, and a form needs none. `note` is a fixed message, never request data. */
export function loginPage(note = '', { retry = '', mode = 'token' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Hatch: log in</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:2em 1em;background:#14161a;color:#e6e6e6}main{max-width:26em;margin:8vh auto}h1{font-size:1.4em}input{font:inherit;width:100%;box-sizing:border-box;padding:.5em;margin:.4em 0 1em;background:#0c0d10;color:inherit;border:1px solid #556;border-radius:4px}button{font:inherit;padding:.5em 1.2em;cursor:pointer}.note{color:#ffb4a8}small{color:#9aa}code{background:#0c0d10;padding:0 .3em}a{color:#8cc4ff}@media(prefers-color-scheme:light){body{background:#f5f5f5;color:#222}input{background:#fff;border-color:#999}code{background:#e6e6e6}.note{color:#a01800}small{color:#555}a{color:#0b5cad}}</style></head>
<body><main><h1>Hatch</h1>${note ? `<p class="note" role="alert">${esc(note)}</p>` : ''}
${mode === 'code'
    ? `<form method="post" action="/login" autocomplete="off"><label>One-time code<input type="text" name="code" autocomplete="off" autocapitalize="characters" maxlength="40" spellcheck="false" autofocus required></label><button type="submit">Log in</button></form>
<p><small>Run <code>hatch-server code</code> on the box: it prints a code like <code>ABCD-EFGH</code>. A code works once and expires after 5 minutes; five wrong attempts cancel it. <a href="/login">Use the token instead</a></small></p>`
    : `<form method="post" action="/login" autocomplete="on"><label>Token<input type="password" name="token" autocomplete="current-password" autofocus required></label><button type="submit">Log in</button></form>
<p><small>The token is in the state dir's <code>config.json</code>; run <code>hatch-server token</code> on the box to print it. <a href="/login?mode=code">Use a one-time code instead</a> (<code>hatch-server code</code>).</small></p>`}${retry}</main></body></html>`;
}

/** Message page for a hosted page opened without a login. The link re-requests the same URL from this origin, which a browser counts as
 *  same-site (a SameSite=Strict cookie is not sent when the first request came from another site, e.g. a chat link). */
export function loginNeededPage(again) {
  return loginPage('You are not logged in to Hatch in this browser. Log in to Hatch first, then open this page again.', { retry: `<p><a href="${esc(again)}">Try again</a> (if you are already logged in and came here from another site)</p><p><a href="/login">Log in</a></p>` });
}

const CODE_MS = 5 * 60 * 1000;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols: no 0/O, 1/I (no digit 0 or 1 and no I or O, so L cannot be mistaken for anything)
export const CODE_LENGTH = 8;
export const CODE_MAX_FAILS = 5;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** What a typed code is compared as: upper case, only letters and digits (spaces, dashes and the like are dropped). */
export const normalizeCode = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
/** The one-time login code, typed into the open login page (the owner's browser often reaches the server under another address than the box
 *  knows, so a link would point at the wrong place). 8 symbols of a 32-symbol alphabet = 40 random bits (crypto.randomInt: no modulo bias),
 *  shown as ABCD-EFGH. Because it is short, guessing is capped: CODE_MAX_FAILS wrong attempts in total, from any address, burn the pending code
 *  (a new one must be issued); the per-address limiter still applies on top. Valid 5 minutes, kept only as a hash in memory, replaced by a newer
 *  code. `use` forgets the code in the same synchronous step that accepts it, so two concurrent requests with one code cannot both succeed.
 *  `use` does the same hash and constant-time compare whether or not a code is pending, so timing says nothing about the state. */
export function createCodes({ now = Date.now, ttlMs = CODE_MS, onBurn = () => {} } = {}) {
  let pending = null; // { hash: Buffer, expires, fails }
  const none = sha('no code pending');
  return {
    issue() {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      pending = { hash: sha(code), expires: now(), fails: 0 }; pending.expires += ttlMs;
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresInSec: Math.floor(ttlMs / 1000) };
    },
    use(given) {
      const h = sha(typeof given === 'string' ? normalizeCode(given) : '');
      const p = pending;
      const same = crypto.timingSafeEqual(p ? p.hash : none, h); // equal-length digests: constant-time compare
      if (!p) return false;
      if (p.expires <= now()) { pending = null; return false; }
      if (same) { pending = null; return true; }
      if (++p.fails >= CODE_MAX_FAILS) { pending = null; onBurn(); }
      return false;
    },
    /** Forget the pending code (revoke, rotate-token, panic). Returns how many were pending. */
    clear() { const n = pending && pending.expires > now() ? 1 : 0; pending = null; return n; },
  };
}
