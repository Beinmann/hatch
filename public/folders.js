// Window folders: a named group of windows in the taskbar. Membership is the `folder` field of each window (so the
// window files stay the source of truth and a hand edit works); a folder exists while it has at least one member in the
// workspace. Folders are flat for now. Names have no "/" (see FOLDER_RE) so a path such as "a/b" could mean nesting later.
// Pure helpers shared by the page and the CLI.
import { mergeOrder, moveItem } from './taskbar-order.js';
export const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// Member order inside a folder: the optional integer `folderOrder` of each window (a hand edit works; a bad value counts as absent).
// Windows without one keep the list order and come first, so old window files behave as before.
export const memberOrderOf = (p) => (Number.isInteger(p.folderOrder) && p.folderOrder >= 0 ? p.folderOrder : 0);
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
    by.get(f).push(p);
  }
  const ids = (ps) => ps.slice().sort((a, b) => memberOrderOf(a) - memberOrderOf(b)).map((p) => p.id); // stable: ties keep the list order
  return { folders: [...by].map(([name, ps]) => [name, ids(ps)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, ids]) => ({ name, ids })), loose };
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

/** Patches that put `ids` into folder `name` at the end of its member order (join order): { id, folder, folderOrder }. */
export function joinPatches(panels, ws, name, ids) {
  let n = Math.max(0, ...panels.filter((p) => inWs(p, ws) && folderOf(p) === name && !ids.includes(p.id)).map(memberOrderOf));
  return ids.map((id) => ({ id, folder: name, folderOrder: ++n }));
}
/** Patches that move member `id` of a folder (member ids in current order) before `beforeId` (null = last); only changed windows. */
export function reorderPatches(panels, memberIds, id, beforeId) {
  const next = moveItem(memberIds, id, beforeId); const by = new Map(panels.map((p) => [p.id, p]));
  return next.map((x, i) => ({ id: x, folderOrder: i + 1 })).filter((u) => by.get(u.id)?.folderOrder !== u.folderOrder);
}
/** Folders in the user's dragged order (`saved` = names, per workspace). Unsaved ones keep their alphabetical order after the saved ones, so a first load looks as before. */
export function orderFolders(folders, saved) {
  const by = new Map(folders.map((f) => [f.name, f]));
  return mergeOrder(saved, folders.map((f) => f.name)).map((n) => by.get(n));
}
/** The saved folder order after renaming `from` to `to`. */
export const renameInOrder = (saved, from, to) => (Array.isArray(saved) ? saved.map((n) => (n === from ? to : n)) : []);
