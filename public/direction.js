// Directional focus ("which window is left/below/above/right of this one"), kept pure so it can be tested.
// Items are { id, x, y, empty } with x/y the rectangle center; the terminal is an item too (id 'term').
// Deterministic: the best candidate has the lowest score, ties go to the lowest id.
// Reversible: `step` remembers the moves made, so the opposite key walks back along the same windows.
export const OPPOSITE = { h: 'l', l: 'h', j: 'k', k: 'j' };
const VEC = { h: [-1, 0], l: [1, 0], k: [0, -1], j: [0, 1] };

// Candidates must lie on that side of the source's center; off-axis distance counts double so near-aligned windows win.
export function pickDirection(items, srcId, dir) {
  const vec = VEC[dir]; const src = items.find((i) => i.id === srcId);
  if (!vec || !src) return null;
  const [dx, dy] = vec; let best = null; let bestScore = Infinity;
  for (const c of items) {
    if (c.id === srcId || c.empty) continue;
    const along = (c.x - src.x) * dx + (c.y - src.y) * dy; const across = Math.abs((c.x - src.x) * dy) + Math.abs((c.y - src.y) * dx);
    if (along <= 1) continue;
    const score = along + 2 * across;
    if (score < bestScore || (score === bestScore && String(c.id) < String(best.id))) { best = c; bestScore = score; }
  }
  return best ? best.id : null;
}

// trail: [{ from, to, dir }] of consecutive moves. The opposite key goes back to where we came from (and pops it);
// any other key extends the trail. A trail that does not end at the current window is stale (focus moved otherwise) and is dropped.
export function step(trail, items, srcId, dir) {
  const t = trail.length && trail[trail.length - 1].to === srcId ? trail : [];
  const last = t[t.length - 1];
  if (last && last.dir === OPPOSITE[dir] && items.some((i) => i.id === last.from && !i.empty)) return { id: last.from, trail: t.slice(0, -1) };
  const id = pickDirection(items, srcId, dir);
  return id === null ? { id: null, trail: t } : { id, trail: [...t, { from: srcId, to: id, dir }].slice(-50) };
}

// Picker fallback for h/l when no on-screen window lies in that direction. `ids` is the taskbar order (on screen first),
// `off` the ids of the windows not on screen. Stepping plainly through `ids` can loop between on-screen windows forever
// (geometry sends l one way, the list order sends it back), so a minimized chip would be unreachable: from an on-screen
// window jump to the first (l) or last (h) off-screen chip; from an off-screen one walk the list.
export function listStep(ids, off, id, dir) {
  const fwd = dir === 'l'; const i = Math.max(0, ids.indexOf(id));
  if (!off.includes(ids[i]) && off.length) return fwd ? off[0] : off[off.length - 1];
  return ids[(i + (fwd ? 1 : ids.length - 1)) % ids.length];
}
