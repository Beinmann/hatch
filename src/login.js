// The login page and the one-time login codes.
import crypto from 'node:crypto';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** The login form. No script: the page CSP forbids inline script, and a form needs none. `note` is a fixed message, never request data. */
export function loginPage(note = '', { retry = '', mode = 'token' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Hatch: log in</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:2em 1em;background:#14161a;color:#e6e6e6}main{max-width:26em;margin:8vh auto}h1{font-size:1.4em}input{font:inherit;width:100%;box-sizing:border-box;padding:.5em;margin:.4em 0 1em;background:#0c0d10;color:inherit;border:1px solid #556;border-radius:4px}button{font:inherit;padding:.5em 1.2em;cursor:pointer}.note{color:#ffb4a8}small{color:#9aa}code{background:#0c0d10;padding:0 .3em}a{color:#8cc4ff}@media(prefers-color-scheme:light){body{background:#f5f5f5;color:#222}input{background:#fff;border-color:#999}code{background:#e6e6e6}.note{color:#a01800}small{color:#555}a{color:#0b5cad}}</style></head>
<body><main><h1>Hatch</h1>${note ? `<p class="note" role="alert">${esc(note)}</p>` : ''}
${mode === 'code'
    ? `<form method="post" action="/login" autocomplete="off"><label>One-time code<input type="text" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus required></label><button type="submit">Log in</button></form>
<p><small>Run <code>hatch-server url --once</code> on the box: it prints a link and the bare code. A code works once and expires after about 5 minutes. <a href="/login">Use the token instead</a></small></p>`
    : `<form method="post" action="/login" autocomplete="on"><label>Token<input type="password" name="token" autocomplete="current-password" autofocus required></label><button type="submit">Log in</button></form>
<p><small>The token is in the state dir's <code>config.json</code>; run <code>hatch-server token</code> on the box to print it. <a href="/login?mode=code">Use a one-time code instead</a> (<code>hatch-server url --once</code>).</small></p>`}${retry}</main></body></html>`;
}

/** Message page for a hosted page opened without a login. The link re-requests the same URL from this origin, which a browser counts as
 *  same-site (a SameSite=Strict cookie is not sent when the first request came from another site, e.g. a chat link). */
export function loginNeededPage(again) {
  return loginPage('You are not logged in to Hatch in this browser. Log in to Hatch first, then open this page again.', { retry: `<p><a href="${esc(again)}">Try again</a> (if you are already logged in and came here from another site)</p><p><a href="/login">Log in</a></p>` });
}

const CODE_MS = 5 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** The one-time login code. The link is made by hand and used at once, so there is room for exactly one: 160 random bits, valid 5 minutes,
 *  kept only as a hash and only in memory. Issuing a new code replaces the old one; `use` forgets the code in the same synchronous step that
 *  accepts it, so two concurrent requests with one code cannot both succeed. */
export function createCodes({ now = Date.now, ttlMs = CODE_MS } = {}) {
  let pending = null; // { hash: Buffer, expires }
  return {
    issue() {
      const code = crypto.randomBytes(20).toString('base64url');
      pending = { hash: sha(code), expires: now() + ttlMs };
      return { code, expiresInSec: Math.floor(ttlMs / 1000) };
    },
    use(given) {
      if (typeof given !== 'string' || !pending) return false;
      const p = pending; const h = sha(given);
      if (!crypto.timingSafeEqual(p.hash, h) || p.expires <= now()) return false; // hashes have equal length: constant-time compare
      pending = null; return true;
    },
    /** Forget the pending code (revoke, rotate-token, panic). Returns how many were pending. */
    clear() { const n = pending && pending.expires > now() ? 1 : 0; pending = null; return n; },
  };
}
