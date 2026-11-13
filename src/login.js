// The login page and the one-time login codes.
import crypto from 'node:crypto';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** The login form. No script: the page CSP forbids inline script, and a form needs none. `note` is a fixed message, never request data. */
export function loginPage(note = '', { retry = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Hatch: log in</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:2em 1em;background:#14161a;color:#e6e6e6}main{max-width:26em;margin:8vh auto}h1{font-size:1.4em}input{font:inherit;width:100%;box-sizing:border-box;padding:.5em;margin:.4em 0 1em;background:#0c0d10;color:inherit;border:1px solid #556;border-radius:4px}button{font:inherit;padding:.5em 1.2em;cursor:pointer}.note{color:#ffb4a8}small{color:#9aa}code{background:#0c0d10;padding:0 .3em}a{color:#8cc4ff}@media(prefers-color-scheme:light){body{background:#f5f5f5;color:#222}input{background:#fff;border-color:#999}code{background:#e6e6e6}.note{color:#a01800}small{color:#555}a{color:#0b5cad}}</style></head>
<body><main><h1>Hatch</h1>${note ? `<p class="note" role="alert">${esc(note)}</p>` : ''}
<form method="post" action="/login" autocomplete="on"><label>Token<input type="password" name="token" autocomplete="current-password" autofocus required></label><button type="submit">Log in</button></form>
<p><small>The token is in the state dir's <code>config.json</code>; run <code>hatch-server token</code> on the box to print it, or <code>hatch-server url --once</code> for a single-use login link.</small></p>${retry}</main></body></html>`;
}

/** Message page for a hosted page opened without a login. The link re-requests the same URL from this origin, which a browser counts as
 *  same-site (a SameSite=Strict cookie is not sent when the first request came from another site, e.g. a chat link). */
export function loginNeededPage(again) {
  return loginPage('You are not logged in to Hatch in this browser. Log in to Hatch first, then open this page again.', { retry: `<p><a href="${esc(again)}">Try again</a> (if you are already logged in and came here from another site)</p><p><a href="/login">Log in</a></p>` });
}

const CODE_MS = 5 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** Single-use login codes: 160 random bits, valid 5 minutes, kept only as a hash and only in memory. `use` removes the matching entry in the same
 *  synchronous step that finds it, so two concurrent requests with one code cannot both succeed. */
export function createCodes({ now = Date.now, ttlMs = CODE_MS, max = 20 } = {}) {
  const codes = []; // { hash: Buffer, expires }
  const sweep = () => { const t = now(); for (let i = codes.length - 1; i >= 0; i--) if (codes[i].expires <= t) codes.splice(i, 1); };
  return {
    issue() {
      sweep(); while (codes.length >= max) codes.shift();
      const code = crypto.randomBytes(20).toString('base64url');
      codes.push({ hash: sha(code), expires: now() + ttlMs });
      return { code, expiresInSec: Math.floor(ttlMs / 1000) };
    },
    use(given) {
      if (typeof given !== 'string' || given.length < 20 || given.length > 64) return false;
      sweep(); const h = sha(given); let hit = -1;
      for (let i = 0; i < codes.length; i++) if (crypto.timingSafeEqual(codes[i].hash, h)) hit = i; // every entry is compared: no early exit to time
      if (hit < 0) return false;
      codes.splice(hit, 1); return true;
    },
    clear() { codes.length = 0; },
    get size() { return codes.length; },
  };
}
