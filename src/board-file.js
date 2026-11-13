// Board files: `hatch widget open board ./plan.board.json` makes a board widget whose exec sources read and write
// that one file instead of the widget's own data/board.json. The file path is checked here and pinned (shell-quoted)
// into the widget's source commands, so the page can only ever reach that file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BOARD_SUFFIX = '.board.json';
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** Validates a board file path from a client: absolute, ends in .board.json, an existing regular file (symlinks are
 *  followed to their target, which must be a regular file) or a new file in an existing directory. Returns the real path. */
export function resolveBoardFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file)) throw bad('board file must be an absolute path without control characters');
  if (!path.basename(file).endsWith(BOARD_SUFFIX) || path.basename(file) === BOARD_SUFFIX) throw bad(`a board file must be named NAME${BOARD_SUFFIX} (got ${path.basename(file)})`);
  let real;
  try { real = fs.realpathSync(file); } catch (e) {
    if (e.code !== 'ENOENT') throw bad(`cannot use ${file}: ${e.message}`);
    let parent; try { parent = fs.realpathSync(path.dirname(file)); } catch { throw bad(`the folder of ${file} does not exist; create it first`); }
    if (!fs.statSync(parent).isDirectory()) throw bad(`not a folder: ${path.dirname(file)}`);
    return path.join(parent, path.basename(file)); // new file: the board creates it on its first save
  }
  if (!fs.statSync(real).isFile()) throw bad(`${file} is not a regular file`);
  if (!real.endsWith(BOARD_SUFFIX)) throw bad(`${file} points to ${path.basename(real)}, which is not named *${BOARD_SUFFIX}`);
  return real;
}

/** widget.json for a board bound to `file`: the shipped one with load and save pinned to it (same protocol as the default). */
export function boardFileMeta(shippedMeta, file) {
  // Same protocol as the shipped widget.json. The root board is the file itself; a nested board `ID` (letters, digits, - and _ only)
  // lives next to it as NAME.ID.board.json. Chunks go to a temp file next to the target (same filesystem), then one mv makes the save atomic.
  const setup = `R=${quote(file)};`;
  const pick = `case "$ID" in '') F="$R";; *[!A-Za-z0-9_-]*) echo "bad board id" >&2; exit 1;; *) F="\${R%${BOARD_SUFFIX}}.$ID${BOARD_SUFFIX}";; esac`;
  const load = `${setup} ID="\${HATCH_ARG:-}"; ${pick}; if [ -s "$F" ]; then cat "$F"; else printf 'null'; fi`;
  const where = `${setup} ID="\${HATCH_ARG:-}"; ${pick}; printf '%s' "$F"`;
  const save = `${setup} A="$HATCH_ARG"; OP="\${A%% *}"; DATA="\${A#* }"; case "$OP" in *:*) ID="\${OP#*:}"; OP="\${OP%%:*}";; *) ID=;; esac; ${pick}; T="$F.hatch-tmp"; case "$OP" in B) printf '%s' "$DATA" > "$T";; A) printf '%s' "$DATA" >> "$T";; C) mv "$T" "$F" || exit 1;; *) echo 'unknown save step' >&2; exit 1;; esac; printf '{"ok":true}'`;
  const cmds = { load, save, path: where };
  const sources = (shippedMeta.sources || []).map((s) => (cmds[s.name] ? { ...s, cmd: cmds[s.name] } : s));
  return { ...shippedMeta, title: `Board: ${path.basename(file, BOARD_SUFFIX)}`, file, sources };
}

/** Widget folder name for a board file: board-<slug>, plus a short hash when another file already uses that name. */
export function boardWidgetName(file, existingFileOf) {
  const slug = (path.basename(file, BOARD_SUFFIX).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'file').slice(0, 40);
  const name = `board-${slug}`;
  const other = existingFileOf(name);
  return other === undefined || other === file ? name : `${name}-${crypto.createHash('sha1').update(file).digest('hex').slice(0, 6)}`;
}

/** The default board lives in the state dir, outside any widget folder, so closing or deleting its window never loses it. */
export const defaultBoardFile = (stateDir) => path.join(stateDir, 'boards', `default${BOARD_SUFFIX}`);

/** One-time move of the old widget-local default board (widgets/board/data/board.json and board.ID.json children) to `file`.
 *  Copies, never deletes; does nothing when `file` already exists or there was no old board. */
export function migrateOldDefault(widgetsDir, file) {
  const old = path.join(widgetsDir, 'board', 'data');
  if (fs.existsSync(file) || !fs.existsSync(path.join(old, 'board.json'))) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const f of fs.readdirSync(old)) {
    const m = /^board(?:\.([A-Za-z0-9_-]+))?\.json$/.exec(f);
    if (m) fs.copyFileSync(path.join(old, f), m[1] ? file.slice(0, -BOARD_SUFFIX.length) + `.${m[1]}${BOARD_SUFFIX}` : file);
  }
  return true;
}

/** Known board files: the default one, every file a board widget in widgets/ is bound to, and the *.board.json files in boards/.
 *  Nested boards (NAME.ID.board.json) are not listed on their own. Newest first. */
export function listBoardFiles(stateDir, widgetNames, metaOf, isOpen) {
  const found = new Map(), add = (file, widget) => {
    if (typeof file !== 'string' || !file.endsWith(BOARD_SUFFIX) || found.has(file)) return;
    let mtime = null; try { mtime = fs.statSync(file).mtimeMs; } catch { /* a bound file that was never saved, or was removed */ }
    found.set(file, { file, name: path.basename(file, BOARD_SUFFIX), widget: widget || null, open: !!widget && isOpen(widget), exists: mtime !== null, mtime });
  };
  for (const w of widgetNames) add(metaOf(w)?.file, w);
  const dir = path.join(stateDir, 'boards');
  try { for (const f of fs.readdirSync(dir)) add(path.join(dir, f), null); } catch { /* no boards dir yet */ }
  const nested = (e) => [...found.keys()].some((k) => k !== e.file && e.file.startsWith(k.slice(0, -BOARD_SUFFIX.length) + '.'));
  return [...found.values()].filter((e) => !nested(e)).sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}
