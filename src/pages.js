// HTML page windows: `hatch open FILE.html` renders the file in a sandboxed iframe. The page and its sibling assets are served
// from the file's own directory under /page/KEY/..., where KEY is a random id made when the window opens. That route needs no
// token (a sandboxed frame has an opaque origin and cannot send our cookie), so KEY is the only authorisation: it exists only
// while the window exists, and it is never reachable by a file served from here (they run in an opaque origin, see server.js).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PAGE_KEY_RE = /^[a-f0-9]{32}$/;
export const isPageFile = (file) => /\.html?$/i.test(String(file));
/** Window type `hatch open` picks for a path: directory, image, HTML page (rendered in a sandbox) or text editor. */
export const openTypeFor = (f, isDir) => (isDir ? 'files' : /\.(png|jpe?g|gif|webp|svg)$/i.test(f) ? 'image' : isPageFile(f) ? 'page' : 'editor');
export const newPageKey = () => crypto.randomBytes(16).toString('hex');

/**
 * The real path of `rel` (URL-decoded, relative) inside `dir`, or null. Refused: anything that resolves outside `dir`
 * (.. segments, symlinks that lead out, checked on the real path), hidden files and folders (.git, .env: a page has no
 * business reading them), NUL bytes, and anything that is not a regular file.
 */
export function resolvePageFile(dir, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const parts = rel.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || x.startsWith('.'))) return null;
  try {
    const base = fs.realpathSync(dir);
    const real = fs.realpathSync(path.join(base, ...parts));
    if (real !== base && !real.startsWith(base + path.sep)) return null;
    // a symlink inside the folder may point at another hidden or outside file only if it ends up inside; hidden targets are refused too
    if (path.relative(base, real).split(path.sep).some((x) => x.startsWith('.'))) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}
