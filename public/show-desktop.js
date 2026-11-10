// "Show desktop": one key minimizes every floating window of the shown workspace; pressing it again before anything
// changed brings them back in the same formation. These are the pure parts (what to do, and whether anything changed);
// windows.js applies them.
//
// Rule: the second press restores only when the windows look exactly as the first press left them (same set of windows,
// same positions, sizes, maximized and minimized flags). If a window was opened, closed, moved, resized, or restored by
// hand in between, the memory is dropped and the press minimizes whatever is showing (nothing showing: nothing happens).
const inShown = (p, ws) => p.placement === 'float' && (p.sticky || (p.ws || 'main') === ws);

/** A string that changes when any window of this workspace is opened, closed, moved, resized, maximized, minimized or restored. */
export function formation(panels, ws) {
  return JSON.stringify(panels.filter((p) => inShown(p, ws)).map((p) => [p.id, p.x, p.y, p.w, p.h, !!p.maximized, !!p.minimized]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** What the key does now. memo is what the last minimize left behind ({ ws, ids, after }) or null.
 *  focusHistory: window ids, most recently focused first. Returns { action: 'restore', ids } with ids in the order to
 *  restore them (the most recently focused last, so it ends up on top and focused), { action: 'minimize', ids } or { action: 'none' }. */
export function planShowDesktop(panels, ws, memo, focusHistory = []) {
  if (memo && memo.ws === ws && memo.after === formation(panels, ws)) {
    const ids = memo.ids.filter((id) => panels.some((p) => p.id === id));
    const rank = (id) => { const i = focusHistory.indexOf(id); return i < 0 ? Infinity : i; }; // never focused: restored first, at the back
    return { action: 'restore', ids: [...ids].sort((a, b) => rank(b) - rank(a)) };
  }
  const ids = panels.filter((p) => inShown(p, ws) && !p.minimized).map((p) => p.id);
  return ids.length ? { action: 'minimize', ids } : { action: 'none' };
}

/** The memory to keep after minimizing `ids`; `panels` is the state with them already minimized. */
export const rememberMinimized = (panels, ws, ids) => ({ ws, ids, after: formation(panels, ws) });
