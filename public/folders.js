// Window folders: a named group of windows in the taskbar. Membership is the `folder` field of each window (so the
// window files stay the source of truth and a hand edit works); a folder exists while it has at least one member in the
// workspace. Folders are flat for now. Names have no "/" (see FOLDER_RE) so a path such as "a/b" could mean nesting later.
// Pure helpers shared by the page and the CLI.
export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const wsOf = (p) => p.ws || 'main';
/** Is this window listed in workspace `ws`? (sticky windows show everywhere) */
const inWs = (p, ws) => p.sticky || wsOf(p) === ws;
/** The folder a window is in, or null. */
export const folderOf = (p) => (typeof p.folder === 'string' && FOLDER_RE.test(p.folder) ? p.folder : null);

/** Split the windows of `ws` into folders (sorted by name, members in the given order) and loose ones: { folders: [{ name, ids }], loose: [id] }. */
export function groupWindows(panels, ws) {
  const by = new Map(); const loose = [];
  for (const p of panels) {
    if (!inWs(p, ws)) continue;
    const f = folderOf(p);
    if (!f) { loose.push(p.id); continue; }
    if (!by.has(f)) by.set(f, []);
    by.get(f).push(p.id);
  }
  return { folders: [...by].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, ids]) => ({ name, ids })), loose };
}

/** An unused folder name in `ws`: base, then base-2, base-3 ... */
export function freeFolderName(panels, ws, base = 'Folder') {
  const used = new Set(groupWindows(panels, ws).folders.map((f) => f.name.toLowerCase()));
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base}-${n}`; if (!used.has(name.toLowerCase())) return name; }
}

/** Resolve what a user typed (window id, widget name, or an unambiguous title) to a window of `ws`. Throws an Error that says what to do. */
export function resolveWindow(panels, ws, ref) {
  const mine = panels.filter((p) => inWs(p, ws));
  const hit = mine.find((p) => p.id === ref) || mine.find((p) => p.id === `w-${ref}`);
  if (hit) return hit;
  const byTitle = mine.filter((p) => p.title === ref);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new Error(`"${ref}" matches ${byTitle.length} windows by title; use an id from \`hatch panels\``);
  throw new Error(`no window "${ref}" in workspace ${ws}; ids are listed by \`hatch panels\``);
}

/** Is `name` usable? Returns an error message or null. */
export const folderNameProblem = (name) => (FOLDER_RE.test(String(name)) ? null : 'a folder name is letters, digits, - and _ (up to 64, starting with a letter or digit)');

/** Window patches that dissolve folder `name` in `ws`: members go back to the main bar. */
export const deletePatches = (panels, ws, name) => panels.filter((p) => inWs(p, ws) && folderOf(p) === name).map((p) => ({ id: p.id, folder: null }));
/** Window patches that rename folder `from` to `to` in `ws`. */
export const renamePatches = (panels, ws, from, to) => panels.filter((p) => inWs(p, ws) && folderOf(p) === from).map((p) => ({ id: p.id, folder: to }));
