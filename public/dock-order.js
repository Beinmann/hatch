// Pure order logic for the dock column. Each docked panel may carry an integer `dockOrder`; panels without one
// (never reordered, or new) go after the numbered ones, oldest first, so every browser tab derives the same order.

/** Ids of the docked panels in display order. */
export function dockIds(panels) {
  const key = (p) => (Number.isFinite(p.dockOrder) ? p.dockOrder : Infinity);
  return panels.filter((p) => p.placement === 'dock')
    .sort((a, b) => (key(a) === key(b) ? 0 : key(a) < key(b) ? -1 : 1) || String(a.created || '').localeCompare(String(b.created || '')) || String(a.id).localeCompare(String(b.id)))
    .map((p) => p.id);
}

/** New id order after moving `id` to just before `beforeId` (null = to the end). Unknown ids leave the list unchanged. */
export function moveBefore(ids, id, beforeId) {
  if (!ids.includes(id) || id === beforeId || (beforeId !== null && !ids.includes(beforeId))) return ids.slice();
  const rest = ids.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  rest.splice(at, 0, id);
  return rest;
}

/** Index of the gap (0..n) a pointer at `y` falls into, given the vertical midpoints of the visible items in order. */
export function gapAt(mids, y) {
  let i = 0;
  while (i < mids.length && y > mids[i]) i++;
  return i;
}

/** Panels whose stored dockOrder must change so the stored ranks equal `ids`: [{ id, dockOrder }]. */
export function orderPatches(ids, panels) {
  const by = new Map(panels.map((p) => [p.id, p]));
  return ids.map((id, i) => ({ id, dockOrder: i })).filter((u) => by.get(u.id)?.dockOrder !== u.dockOrder);
}
