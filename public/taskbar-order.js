// Pure helpers for the taskbar (no DOM): the row of slots (loose windows and folders in one row, see below) and drag helpers.

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

// The taskbar is ONE row of slots. A slot holds a loose window { w: id }, a folder { f: name } or is open (null). The two
// kinds live under different keys, so a window id and a folder name can never be mistaken for each other. The slot number
// is the 1-based position in the row; a folder is one slot. All functions below return a new row and never mutate.
const isW = (e) => !!e && typeof e.w === 'string';
const isF = (e) => !!e && typeof e.f === 'string';
/** A unique key per entry ('w:id' / 'f:name'), null for an open spot. */
export const entryKey = (e) => (isW(e) ? `w:${e.w}` : isF(e) ? `f:${e.f}` : null);
const trim = (row) => { const out = row.slice(); while (out.length && out[out.length - 1] === null) out.pop(); return out; };
const firstOpen = (out, e) => { const g = out.indexOf(null); if (g >= 0) out[g] = e; else out.push(e); };

/** A saved row (parsed JSON) -> a clean row, or null when it is not a row at all (nothing saved, or the old format to migrate). */
export function parseRow(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.some((e) => typeof e === 'string')) return null; // the old layout: a plain list of window ids
  const seen = new Set();
  return trim(raw.map((e) => {
    const k = entryKey(e);
    if (!k || seen.has(k)) return null;
    seen.add(k);
    return isW(e) ? { w: e.w } : { f: e.f };
  }));
}

/**
 * Keep the row stable while windows and folders come and go: entries that are not in `want` (closed windows, vanished
 * folders) leave an open spot, entries of `want` that have no slot fill the first open spot or go to the end; trailing open
 * spots vanish. `want` = entries in the order new ones are placed.
 */
export function reconcileRow(prev, want) {
  const keys = new Set(want.map(entryKey));
  const out = (Array.isArray(prev) ? prev : []).map((e) => (e && keys.has(entryKey(e)) ? e : null));
  const placed = new Set(out.map(entryKey));
  for (const e of want) { const k = entryKey(e); if (!placed.has(k)) { firstOpen(out, e); placed.add(k); } }
  return trim(out);
}

/**
 * The row for a workspace that only has the old saved data: the old loose layout (`oldIds`, ids or null), then the folders in
 * their old saved order, exactly the numbering the taskbar showed before. `order` = all window ids in default order.
 */
export function migrateRow(oldIds, order, looseIds, folderNames) {
  const loose = placeLoose(Array.isArray(oldIds) ? oldIds.filter((x) => typeof x === 'string' || x === null) : [], mergeOrder(oldIds, order), looseIds);
  return [...loose.map((id) => (id === null ? null : { w: id })), ...folderNames.map((f) => ({ f }))];
}

/** Combine windows `ids` into the NEW folder `name`: it takes the lowest slot among them, the others become open spots. */
export function combineRow(row, name, ids) {
  const at = ids.map((id) => row.findIndex((e) => isW(e) && e.w === id)).filter((i) => i >= 0).sort((a, b) => a - b);
  const out = row.slice();
  if (!at.length) { firstOpen(out, { f: name }); return trim(out); }
  for (const i of at) out[i] = null;
  out[at[0]] = { f: name };
  return trim(out);
}

/** Windows `ids` join an existing folder: their slots become open spots, the folder keeps its own. */
export function joinRow(row, ids) {
  return trim(row.map((e) => (isW(e) && ids.includes(e.w) ? null : e)));
}

/** Windows `ids` leave their folder: each takes the first open spot (else the end). `dissolve` = the folder that ends up empty; its slot is freed first. */
export function releaseRow(row, ids, dissolve = null) {
  const out = row.map((e) => (dissolve !== null && isF(e) && e.f === dissolve ? null : e));
  for (const id of ids) if (!out.some((e) => isW(e) && e.w === id)) firstOpen(out, { w: id });
  return trim(out);
}

/** A folder keeps its slot when renamed. */
export function renameRow(row, from, to) {
  return row.map((e) => (isF(e) && e.f === from ? { f: to } : e));
}

/** Drag-reorder: `entry` goes just before `before` (null = the end); the open spots are packed away, as a drag always re-packed the numbers. */
export function moveEntry(row, entry, before) {
  const k = entryKey(entry); const b = before ? entryKey(before) : null;
  const rest = row.filter((e) => e);
  if (!rest.some((e) => entryKey(e) === k) || k === b || (b !== null && !rest.some((e) => entryKey(e) === b))) return rest;
  const without = rest.filter((e) => entryKey(e) !== k);
  without.splice(b === null ? without.length : without.findIndex((e) => entryKey(e) === b), 0, entry);
  return without;
}

/** Drag onto an open spot: `entry` moves to slot `index` (0-based) and leaves its old slot open. Occupied or unknown: unchanged. */
export function placeEntry(row, entry, index) {
  const k = entryKey(entry);
  if (!row.some((e) => entryKey(e) === k) || (row[index] && entryKey(row[index]))) return row.slice();
  const out = row.map((e) => (entryKey(e) === k ? null : e));
  while (out.length <= index) out.push(null);
  out[index] = entry;
  return trim(out);
}

/**
 * The chip positions of the taskbar, from the row ({ kind: 'empty' } for an open spot). Window numbers are the 1-based index into
 * this list, minimized chips included, so Ctrl+3 always means slot 3. `folders` = [{ name, ids }]; a folder entry without one is open.
 */
export function chipSlots(row, folders) {
  const by = new Map(folders.map((f) => [f.name, f]));
  return row.map((e) => (isW(e) ? { kind: 'win', id: e.w } : isF(e) && by.has(e.f) ? { kind: 'folder', name: e.f, ids: by.get(e.f).ids.slice() } : { kind: 'empty' }));
}

/** The number (1-9) shown for window `id`: its own chip's position, or its folder chip's. 0 when it has no chip. */
export function slotNumber(slots, id) {
  const i = slots.findIndex((s) => (s.kind === 'win' ? s.id === id : s.kind === 'folder' && s.ids.includes(id)));
  return i >= 0 && i < 9 ? i + 1 : 0;
}
