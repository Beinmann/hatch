// Opening a text file prefers vim in a terminal window over the built-in textarea editor.
// Done on the server, in one place, so the CLI, the file browser, the palette and Claude's calls all behave the same.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Absolute path of an executable on PATH, or null. */
export function which(bin, env = process.env) {
  if (!bin || /[\\/\s]/.test(bin)) return null;
  for (const d of String(env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/** Config `editor`: "builtin" (textarea), "auto" or unset (vim when installed), or a bare command name such as "nvim". */
export function pickEditor(pref, find = which) {
  if (pref === 'builtin') return null;
  const bin = !pref || pref === 'auto' ? 'vim' : String(pref);
  return find(bin) ? bin : null;
}

/** Looks like text: a regular file under 5 MB with no NUL bytes in its first 8 KB. A missing file is not text (the editor panel reports that). */
export function isTextFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 5 * 1024 * 1024) return false;
    const fd = fs.openSync(file, 'r');
    try { const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, 8192, 0); return !b.subarray(0, n).includes(0); } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** Turns an `editor` panel request into a terminal panel request running the editor on the file; returns the input unchanged when it should stay a textarea. */
export function vimRequest(input, bin, check = isTextFile) {
  if (!bin || input?.type !== 'editor' || input.builtin === true) return input;
  const file = input.props?.path;
  if (typeof file !== 'string' || !path.isAbsolute(file) || !check(file)) return input;
  const line = Number.isInteger(input.props.line) && input.props.line > 0 ? input.props.line : null;
  // the name is the session name, so it is stable per file: opening the same file again re-attaches instead of starting a second vim
  const hash = crypto.createHash('sha1').update(file).digest('hex').slice(0, 6);
  const base = path.basename(file).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'file';
  const { builtin, props, ...rest } = input;
  return { ...rest, type: 'terminal', title: input.title || path.basename(file), props: { name: `vim-${base}-${hash}`, cmd: `${bin} ${line ? `+${line} ` : ''}-- ${q(file)}` } };
}
