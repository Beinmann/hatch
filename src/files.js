// Plain file access for the files and editor panels: list, read text, write text, download, upload.
// V0.1 trust model, same as /api/file: any path the server user can read or write. The planned security pass
// decides on a root dir. Writes are atomic and refuse to overwrite a file that changed since it was read.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './state.js';

export const TEXT_MAX = 1024 * 1024;
export const UPLOAD_MAX = 200 * 1024 * 1024;

export class FsError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Optional confinement (hatch-server serve --root DIR): every path must resolve, symlinks included, to a place inside ROOT.
let ROOT = null;
export function setRoot(dir) { ROOT = dir ? fs.realpathSync(path.resolve(dir)) : null; }
export const getRoot = () => ROOT;
function real(p) { // realpath of the deepest existing ancestor, plus the rest: new files are checked by their parent
  let cur = p; const rest = [];
  for (;;) { try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch (e) { if (e.code !== 'ENOENT' || path.dirname(cur) === cur) return p; rest.push(path.basename(cur)); cur = path.dirname(cur); } }
}
export function abs(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new FsError(400, 'path must be absolute');
  const r = path.resolve(p);
  if (ROOT) { const t = real(r); if (t !== ROOT && !t.startsWith(ROOT + path.sep)) throw new FsError(403, `outside the allowed root (${ROOT}): ${p}`); }
  return r;
}
const wrap = (e, p) => { throw e instanceof FsError ? e : new FsError(e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 400, `${e.code === 'ENOENT' ? 'no such file or directory' : e.code || e.message}: ${p}`); };

export function list(p) {
  p = abs(p);
  try {
    const entries = fs.readdirSync(p, { withFileTypes: true }).map((e) => {
      let st = null; try { st = fs.statSync(path.join(p, e.name)); } catch { /* broken link */ }
      return { name: e.name, type: st ? (st.isDirectory() ? 'dir' : 'file') : 'broken', link: e.isSymbolicLink(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
    });
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: p, parent: path.dirname(p) === p ? null : path.dirname(p), entries };
  } catch (e) { return wrap(e, p); }
}

export function readText(p) {
  p = abs(p);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) throw new FsError(400, `not a regular file: ${p}`);
    if (st.size > TEXT_MAX) throw new FsError(413, `file is larger than ${TEXT_MAX / 1024} KB; open it in the terminal instead`);
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) throw new FsError(415, 'looks like a binary file (contains NUL bytes)');
    return { path: p, text: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
  } catch (e) { return wrap(e, p); }
}

/** Writes text. `mtime` is what the editor read; a different mtime on disk means someone else changed the file (409). */
export function writeText(p, text, mtime) {
  p = abs(p);
  if (typeof text !== 'string') throw new FsError(400, 'text must be a string');
  if (mtime !== undefined && (typeof mtime !== 'number' || !Number.isFinite(mtime))) throw new FsError(400, 'mtime must be a finite number from the file read response');
  if (Buffer.byteLength(text) > TEXT_MAX) throw new FsError(413, `text is larger than ${TEXT_MAX / 1024} KB`);
  try {
    let mode; let target = p; let st;
    try { st = fs.statSync(p); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (mtime !== undefined) throw new FsError(409, 'the file was removed since you opened it; save elsewhere or recreate it explicitly');
      // A dangling link is not a new file: never silently replace it with a regular file.
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new FsError(404, `symbolic link target does not exist: ${p}`); }
      catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    }
    if (st) {
      if (!st.isFile()) throw new FsError(400, `not a regular file: ${p}`);
      if (mtime !== undefined && st.mtimeMs !== mtime) throw new FsError(409, 'the file changed on disk since you opened it; reload it or save elsewhere');
      mode = st.mode & 0o777;
      // Rename over the real target, preserving the link the user opened (including link chains).
      target = abs(fs.realpathSync(p));
    }
    atomicWrite(target, text, { mode });
    return { path: p, size: Buffer.byteLength(text), mtime: fs.statSync(target).mtimeMs };
  } catch (e) { return wrap(e, p); }
}

/** Saves an uploaded file into `dir` without overwriting (409) unless `overwrite`. The name is reduced to a base name. */
export function saveFile(dir, name, buf, overwrite = false) {
  dir = abs(dir);
  const base = path.basename(String(name || '')).replace(/[\0/\\]/g, '');
  if (!base || base === '.' || base === '..') throw new FsError(400, 'a file name is needed (?name=)');
  if (buf.length > UPLOAD_MAX) throw new FsError(413, `file is larger than ${UPLOAD_MAX / 1024 / 1024} MB`);
  const target = path.join(dir, base);
  try {
    if (!fs.statSync(dir).isDirectory()) throw new FsError(400, `not a directory: ${dir}`);
    fs.writeFileSync(target, buf, { flag: overwrite ? 'w' : 'wx' });
    return { path: target, bytes: buf.length };
  } catch (e) { if (e.code === 'EEXIST') throw new FsError(409, `${base} already exists in ${dir}`); return wrap(e, target); }
}

// ---- file management (dired-style): new file, new folder, rename, delete ----
export function mkdir(p) {
  p = abs(p);
  try { fs.mkdirSync(p); return { path: p }; } catch (e) { return e.code === 'EEXIST' ? wrap(new FsError(409, `already exists: ${p}`), p) : wrap(e, p); }
}
export function newFile(p, text = '') {
  p = abs(p);
  try { fs.writeFileSync(p, text, { flag: 'wx' }); return { path: p }; } catch (e) { return e.code === 'EEXIST' ? wrap(new FsError(409, `already exists: ${p}`), p) : wrap(e, p); }
}
/** Renames or moves; never overwrites an existing target. */
export function rename(from, to) {
  from = abs(from); to = abs(to);
  try {
    try { fs.lstatSync(to); throw new FsError(409, `already exists: ${to}`); } catch (e) { if (e instanceof FsError) throw e; } // lstat: a dangling symlink counts as existing
    fs.renameSync(from, to); return { path: to };
  } catch (e) { return wrap(e, from); }
}
/** Deletes a file or an empty folder; a folder with content needs `recursive`. The root itself is never deleted. */
export function remove(p, recursive = false) {
  p = abs(p);
  if (p === path.parse(p).root || (ROOT && p === ROOT)) throw new FsError(400, 'refusing to delete the root');
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) { if (!recursive && fs.readdirSync(p).length) throw new FsError(409, `folder is not empty: ${p} (use recursive)`); fs.rmSync(p, { recursive: true }); } else fs.unlinkSync(p);
    return { path: p };
  } catch (e) { return wrap(e, p); }
}
