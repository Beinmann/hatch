// Pure helpers for the taskbar order (no DOM): the order is a list of window ids the user arranged by dragging chips.
// It is merged with the live window list so closed windows drop out and new windows land at the end.

/** Saved order + current ids (in their default order) -> the order to show. Unknown saved ids are dropped, unseen ids appended. */
export function mergeOrder(saved, current) {
  const have = new Set(current);
  const out = []; const seen = new Set();
  for (const id of Array.isArray(saved) ? saved : []) if (have.has(id) && !seen.has(id)) { out.push(id); seen.add(id); }
  for (const id of current) if (!seen.has(id)) { out.push(id); seen.add(id); }
  return out;
}

/** Move `id` to sit just before `beforeId` (null = the end). Unknown ids, or a move onto itself, change nothing. */
export function moveItem(order, id, beforeId) {
  if (!order.includes(id) || id === beforeId || (beforeId !== null && !order.includes(beforeId))) return order.slice();
  const rest = order.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  rest.splice(at, 0, id);
  return rest;
}

/** Which part of a chip the pointer is over: 'before' (left quarter), 'after' (right quarter) or 'mid' (join or make a folder). */
export function dropZone(rect, x) {
  const f = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  return f < 0.25 ? 'before' : f > 0.75 ? 'after' : 'mid';
}

/**
 * Stable positions for the loose chips: `prev` is the last layout (ids, null = open spot). Closed or foldered windows leave
 * an open spot, new ones (taken from `order`) fill the first open spot or go to the end; trailing open spots vanish.
 */
export function placeLoose(prev, order, looseIds) {
  const loose = new Set(looseIds);
  const out = (Array.isArray(prev) ? prev : []).map((id) => (loose.has(id) ? id : null));
  const placed = new Set(out.filter((id) => id !== null));
  for (const id of order) {
    if (!loose.has(id) || placed.has(id)) continue;
    const gap = out.indexOf(null);
    if (gap >= 0) out[gap] = id; else out.push(id);
    placed.add(id);
  }
  while (out.length && out[out.length - 1] === null) out.pop();
  return out;
}

/**
 * The chip positions of the taskbar: the loose layout from `placeLoose` ({ kind: 'empty' } for an open spot), then the folder
 * chips (as drawn). Window numbers are the 1-based index into this list, minimized chips included, so Ctrl+3 always means slot 3.
 * `folders` = [{ name, ids }] in drawn order.
 */
export function chipSlots(layout, folders) {
  return [...layout.map((id) => (id === null ? { kind: 'empty' } : { kind: 'win', id })), ...folders.map((f) => ({ kind: 'folder', name: f.name, ids: f.ids.slice() }))];
}

/** The number (1-9) shown for window `id`: its own chip's position, or its folder chip's. 0 when it has no chip. */
export function slotNumber(slots, id) {
  const i = slots.findIndex((s) => (s.kind === 'win' ? s.id === id : s.kind === 'folder' && s.ids.includes(id)));
  return i >= 0 && i < 9 ? i + 1 : 0;
}
