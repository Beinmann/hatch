// Pure decisions for taskbar folders (no DOM): what show/hide/Ctrl+N/leader+N do. `members` are { id, minimized } in the
// folder's member order. The page applies the result with setMinimized, so a folder is only a batch of `minimized` patches.

/** Ctrl+N on a folder: any member visible -> hide the whole folder; all hidden -> show all. */
export const folderToggle = (members) => (members.some((m) => !m.minimized) ? 'hide' : 'show');

/** Ids to minimize to hide the folder (the visible members). */
export const hidePlan = (members) => members.filter((m) => !m.minimized).map((m) => m.id);

/**
 * Show all: the minimized members to restore and the member to put on top, the last-focused one (`history` = ids, most recent
 * first), else the first member. `restore` lists the top member last, so restoring in order leaves it focused.
 */
export function showPlan(members, history) {
  const ids = members.map((m) => m.id);
  const top = (Array.isArray(history) ? history : []).find((id) => ids.includes(id)) ?? ids[0] ?? null;
  const restore = members.filter((m) => m.minimized && m.id !== top).map((m) => m.id);
  if (top !== null && members.find((m) => m.id === top)?.minimized) restore.push(top);
  return { restore, top };
}

export const MAX_SUB = 9;
/** Sub numbers: fixed by position in the member order, minimized members keep theirs; only the first 9 get one. [{ id, n }] */
export const subNumbers = (ids) => ids.slice(0, MAX_SUB).map((id, i) => ({ id, n: i + 1 }));

/** Leader + N on a folder slot: one member -> go straight to it; several -> open the numbered popover; none -> nothing. */
export function folderLeaderOpen(ids) {
  if (!ids.length) return { kind: 'none' };
  return ids.length === 1 ? { kind: 'go', id: ids[0] } : { kind: 'popover' };
}

/**
 * The key pressed while the numbered popover waits (`ids` = members in order, `e` = { key, code }): { action: 'pick', id } for
 * a digit that has a member, { action: 'all' } for 0, { action: 'ignore' } for a modifier or a digit without member (stay open),
 * { action: 'cancel' } for Escape or anything else.
 */
export function folderLeaderKey(ids, e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return { action: 'ignore' };
  const d = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
  if (!d) return { action: 'cancel' };
  const n = Number(d[1]);
  if (n === 0) return { action: 'all' };
  const hit = subNumbers(ids).find((s) => s.n === n);
  return hit ? { action: 'pick', id: hit.id } : { action: 'ignore' };
}

/**
 * The number shown on a window's title bar: its slot number ("3") when loose, "N.m" for the m-th member of folder slot N
 * (first 9 members only). '' when the window is not shown, is in no slot, its slot is 10 or higher, or it has no sub number.
 * `slots` = chipSlots(...) ({ kind: 'win', id } | { kind: 'folder', ids } | { kind: 'empty' }), the same numbering as Ctrl+N.
 */
export function windowLabel(slots, id, shown = true) {
  if (!shown) return '';
  const i = slots.findIndex((s) => (s.kind === 'win' ? s.id === id : s.kind === 'folder' && s.ids.includes(id)));
  if (i < 0 || i >= MAX_SUB) return '';
  const s = slots[i];
  if (s.kind === 'win') return String(i + 1);
  const m = subNumbers(s.ids).find((x) => x.id === id);
  return m ? `${i + 1}.${m.n}` : '';
}
