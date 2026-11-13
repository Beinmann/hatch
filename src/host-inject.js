// Makes a hosted page's relative links load through a per-load secret path. The page sits in a sandbox (opaque origin), so its sub-resources
// cannot send the login cookie; a <base href="/host-r/SECRET/ID/"> as the first thing in <head> sends them to a path that carries the secret
// instead. The address bar keeps the plain /host/ID/NAME. Works on bytes (latin1 round trip) so the page's own encoding is untouched.
const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PAGE_BYTES = MAX_BYTES;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// A <base> makes "#section" links resolve to the folder URL, which would navigate away; this keeps them in the page.
const ANCHOR_FIX = '<script>addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest(\'a[href^="#"]\');if(!a||e.defaultPrevented)return;var id=a.getAttribute("href").slice(1);try{id=decodeURIComponent(id)}catch(x){}e.preventDefault();var t=id?document.getElementById(id)||document.getElementsByName(id)[0]:document.documentElement;if(t)t.scrollIntoView()})</script>';
const HREF_RE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ABSOLUTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** `buf` (the page's bytes) with the base tag put in; `base` is the path /host-r/SECRET/ID/ . Returns { body, injected }; a page that cannot be
 *  changed (UTF-16, or a <base> that already points at another site) is returned as is with injected: false. */
export function injectBase(buf, base) {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return { body: buf, injected: false };
  let text = buf.toString('latin1'); let href = base;
  const headEnd = (() => { const i = text.slice(0, 1 << 16).search(/<\/head\s*>|<body[\s>]/i); return i < 0 ? Math.min(text.length, 1 << 16) : i; })();
  let head = text.slice(0, headEnd); const rest = text.slice(headEnd);
  let absolute = false;
  head = head.replace(/<base\b[^>]*>/gi, (tag) => {
    const m = HREF_RE.exec(tag); if (!m) return tag;
    const given = m[1] ?? m[2] ?? m[3] ?? '';
    if (ABSOLUTE_RE.test(given)) { absolute = true; return tag; } // the page chose another site on purpose: leave it alone
    if (!given.startsWith('/') && !/[&"'<>\\]/.test(given)) { // a folder inside the hosted folder: fold it into ours
      try { const p = new URL(given, `http://x${base}`).pathname; if (p.startsWith(base)) href = p; } catch { /* keep ours */ }
    }
    return tag.replace(HREF_RE, ''); // only the first <base href> counts and ours comes first; a root-relative one cannot work here
  });
  if (absolute) return { body: buf, injected: false };
  const ours = `<base href="${esc(href)}">${ANCHOR_FIX}`;
  const bom = text.startsWith('ï»¿') ? 3 : 0;
  let m;
  if ((m = /<head(?=[\s>])[^>]*>/i.exec(head))) head = head.slice(0, m.index + m[0].length) + ours + head.slice(m.index + m[0].length);
  else if ((m = /<html(?=[\s>])[^>]*>/i.exec(head))) head = `${head.slice(0, m.index + m[0].length)}<head>${ours}${head.slice(m.index + m[0].length)}`; // the parser closes the head when body content starts
  else if ((m = /^(?:ï»¿)?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(head))) head = head.slice(0, m[0].length) + ours + head.slice(m[0].length);
  else head = head.slice(0, bom) + ours + head.slice(bom);
  text = head + rest;
  return { body: Buffer.from(text, 'latin1'), injected: true };
}
