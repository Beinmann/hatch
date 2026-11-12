// Read-only file serving from one directory: the path checks shared by every route that exposes a folder.
// A request path is accepted only when, symlinks resolved, it is a regular file inside the folder, and no
// segment is a dotfile (.git, .env, ...). Anything else is simply "not found".
import fs from 'node:fs';
import path from 'node:path';

/** Real path of ROOT, or null when it is not a directory. Resolve once, when the folder is registered. */
export function realDir(root) {
  try { const r = fs.realpathSync(root); return fs.statSync(r).isDirectory() ? r : null; } catch { return null; }
}

/** Real path of the regular file REL (a decoded, "/"-separated request path) inside realRoot, or null. */
export function resolveInside(realRoot, rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((s) => s === '..' || s.startsWith('.') || s.includes('\0'))) return null;
  try {
    const real = fs.realpathSync(path.join(realRoot, ...parts)); // follows symlinks, so a link that leaves the folder resolves outside it
    if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}
