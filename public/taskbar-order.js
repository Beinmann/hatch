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
