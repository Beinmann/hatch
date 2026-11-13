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

/** New id order after inserting `id` (docked or not yet) just before `beforeId` (null = end). Unknown beforeId appends. */
export function insertBefore(ids, id, beforeId) {
  const rest = ids.filter((x) => x !== id);
  const at = beforeId === null || !rest.includes(beforeId) ? rest.length : rest.indexOf(beforeId);
  rest.splice(at, 0, id);
  return rest;
}

/** Is the point inside the rect ({left,top,right,bottom})? Used to tell "over the dock" from "over the floating area". */
export function inRect(r, x, y) {
  return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Where a window released at the pointer lands as a floating one: top-left keeps the grab offset, clamped into the area
 *  ({left,top} of the area in page coordinates, {width,height} its size). Returns area-relative { x, y, w, h }. */
export function floatLanding(pointer, grab, size, areaRect, areaSize) {
  const w = Math.min(size.w, areaSize.width); const h = Math.min(size.h, areaSize.height);
  const x = Math.max(0, Math.min(areaSize.width - w, pointer.x - grab.x - areaRect.left));
  const y = Math.max(0, Math.min(areaSize.height - h, pointer.y - grab.y - areaRect.top));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
