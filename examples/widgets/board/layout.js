// Board auto-layout (pure functions, no DOM): layered left to right by arrows, siblings stacked, cards that have no
// arrow in a grid below. Boards are never mutated. Loaded as a classic script in the widget (window.BoardLayout)
// and by node tests. Only x and y change; sizes, text, ids and arrows are kept.
(function (root) {
  const GAP_X = 90, GAP_Y = 36, GRID_GAP = 30, DEF_W = 180, DEF_H = 100;
  const fin = (v) => Number.isFinite(v);
  const size = (c) => ({ w: fin(c.w) ? c.w : DEF_W, h: fin(c.h) ? c.h : DEF_H });

  /** Layer index per card id: longest path from a source, ignoring arrows that close a cycle (found by DFS). */
  function layers(ids, arrows) {
    const out = new Map(ids.map((i) => [i, []]));
    for (const a of arrows) if (out.has(a.from) && out.has(a.to) && a.from !== a.to) out.get(a.from).push(a.to);
    const state = new Map(), back = new Set(), order = [];
    const visit = (s) => { // iterative DFS: a long chain must not overflow the stack
      const stack = [[s, 0]]; state.set(s, 1);
      while (stack.length) {
        const top = stack[stack.length - 1], kids = out.get(top[0]);
        if (top[1] < kids.length) {
          const k = kids[top[1]++];
          if (state.get(k) === 1) back.add(top[0] + '>' + k); else if (!state.get(k)) { state.set(k, 1); stack.push([k, 0]); }
        } else { state.set(top[0], 2); order.push(top[0]); stack.pop(); }
      }
    };
    for (const i of ids) if (!state.get(i)) visit(i);
    const layer = new Map(ids.map((i) => [i, 0]));
    for (const i of order.reverse()) for (const k of out.get(i)) if (!back.has(i + '>' + k)) layer.set(k, Math.max(layer.get(k), layer.get(i) + 1));
    return layer;
  }

  /** Grid of cards (ids in order) with its top-left at (x0, y0), `cols` per row; rows are as tall as their tallest card. */
  function grid(cards, ids, x0, y0, cols, pos) {
    let y = y0;
    for (let i = 0; i < ids.length; i += cols) {
      let x = x0, rowH = 0;
      for (const id of ids.slice(i, i + cols)) { const s = size(cards.get(id)); pos.set(id, { x, y }); x += s.w + GRID_GAP; rowH = Math.max(rowH, s.h); }
      y += rowH + GRID_GAP;
    }
    return y;
  }
  const colsFor = (n, width, avgW) => Math.max(1, Math.min(n, Math.max(Math.ceil(Math.sqrt(n)), Math.floor(width / (avgW + GRID_GAP)))));

  /** New positions {id: {x, y}} for every card. The top-left of the old bounding box stays where it was. */
  function positions(board) {
    const cards = new Map(board.cards.map((c) => [c.id, c])), pos = new Map();
    if (!cards.size) return pos;
    const ox = Math.min(...board.cards.map((c) => (fin(c.x) ? c.x : 0))), oy = Math.min(...board.cards.map((c) => (fin(c.y) ? c.y : 0)));
    const linked = new Set(); for (const a of board.arrows) if (cards.has(a.from) && cards.has(a.to) && a.from !== a.to) { linked.add(a.from); linked.add(a.to); }
    const ids = board.cards.map((c) => c.id).filter((i) => linked.has(i)), loose = board.cards.map((c) => c.id).filter((i) => !linked.has(i));
    let bottom = oy, right = ox;
    if (ids.length) {
      const layer = layers(ids, board.arrows), n = Math.max(...layer.values()) + 1, cols = Array.from({ length: n }, () => []);
      for (const i of ids) cols[layer.get(i)].push(i);
      // order inside a column: a few barycenter sweeps (average row of the neighbours) cut crossings; ties keep card order
      const row = new Map(); cols.forEach((c) => c.forEach((i, r) => row.set(i, r)));
      const nb = (i, dir) => board.arrows.filter((a) => (dir < 0 ? a.to === i : a.from === i) && row.has(dir < 0 ? a.from : a.to)).map((a) => row.get(dir < 0 ? a.from : a.to));
      for (let pass = 0; pass < 4; pass++) {
        const seq = pass % 2 ? [...cols.keys()].reverse() : [...cols.keys()], dir = pass % 2 ? 1 : -1;
        for (const k of seq) {
          const key = new Map(cols[k].map((i) => { const ns = nb(i, dir); return [i, ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : row.get(i)]; }));
          cols[k].sort((a, b) => key.get(a) - key.get(b) || row.get(a) - row.get(b)); cols[k].forEach((i, r) => row.set(i, r));
        }
      }
      const heights = cols.map((c) => c.reduce((s, i) => s + size(cards.get(i)).h, 0) + GAP_Y * (c.length - 1)), tallest = Math.max(...heights);
      let x = ox;
      cols.forEach((c, k) => {
        let y = oy + (tallest - heights[k]) / 2; // columns share a centre line
        const colW = Math.max(...c.map((i) => size(cards.get(i)).w));
        for (const i of c) { pos.set(i, { x, y: Math.round(y) }); y += size(cards.get(i)).h + GAP_Y; }
        x += colW + GAP_X;
      });
      right = x - GAP_X; bottom = oy + tallest;
    }
    if (loose.length) {
      const avg = loose.reduce((s, i) => s + size(cards.get(i)).w, 0) / loose.length;
      grid(cards, loose, ox, ids.length ? bottom + GAP_Y * 2 : oy, colsFor(loose.length, Math.max(right - ox, 3 * (avg + GRID_GAP)), avg), pos);
    }
    return pos;
  }

  const apply = (board, pos) => ({ ...board, cards: board.cards.map((c) => (pos.has(c.id) ? { ...c, x: Math.round(pos.get(c.id).x), y: Math.round(pos.get(c.id).y) } : c)) });
  /** The whole board laid out (the "Tidy" action). */
  const layout = (board) => apply(board, positions(board));

  /** Only `ids` get placed: in a grid under everything else (for cards that arrived without a position). */
  function placeNew(board, ids) {
    const mark = new Set(ids), rest = board.cards.filter((c) => !mark.has(c.id));
    if (!rest.length) return layout(board);
    const cards = new Map(board.cards.map((c) => [c.id, c])), pos = new Map();
    const left = Math.min(...rest.map((c) => c.x)), bottom = Math.max(...rest.map((c) => c.y + size(c).h)), right = Math.max(...rest.map((c) => c.x + size(c).w));
    const avg = ids.reduce((s, i) => s + size(cards.get(i)).w, 0) / ids.length;
    grid(cards, ids, left, bottom + GAP_Y * 2, colsFor(ids.length, Math.max(right - left, 3 * (avg + GRID_GAP)), avg), pos);
    return apply(board, pos);
  }

  const overlap = (a, b) => { const p = size(a), q = size(b); return a.x < b.x + q.w && b.x < a.x + p.w && a.y < b.y + q.h && b.y < a.y + p.h; };
  /** Ids of raw cards (as read from a file) with no numeric x or y: the writer did not choose a position. */
  const unplaced = (rawCards) => (Array.isArray(rawCards) ? rawCards : []).filter((c) => c && typeof c.id === 'string' && !(fin(c.x) && fin(c.y))).map((c) => c.id);
  /** True when a board "arrived" in a state nobody arranged: at least half of the cards sit on top of another card
   *  (all at the origin, say). A board with a few deliberate overlaps is left alone. */
  function looksUnarranged(board) {
    const cs = board.cards; if (cs.length < 2) return false;
    const hit = new Set();
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) if (overlap(cs[i], cs[j])) { hit.add(i); hit.add(j); }
    return hit.size * 2 >= cs.length;
  }
  /** What to do with a board just read from a file: a board with no positions at all or one that looks unarranged is
   *  laid out fully; one where only some cards lack a position gets just those placed below the rest; else unchanged.
   *  `raw` is the parsed JSON (before sanitizing), `board` the sanitized board. Returns {board, changed}. */
  function onLoad(raw, board) {
    const missing = unplaced(raw && raw.cards).filter((i) => board.cards.some((c) => c.id === i));
    const placed = { ...board, cards: board.cards.filter((c) => !missing.includes(c.id)) }; // unplaced cards all sit at 0,0: ignore them here
    if (missing.length === board.cards.length && board.cards.length > 1 || looksUnarranged(placed)) return { board: layout(board), changed: true };
    if (missing.length) return { board: placeNew(board, missing), changed: true };
    return { board, changed: false };
  }

  /** {id: {x, y}} of all cards, and putting such a snapshot back (cards that are gone are skipped). For undo. */
  const snapshot = (board) => Object.fromEntries(board.cards.map((c) => [c.id, { x: c.x, y: c.y }]));
  const restore = (board, snap) => ({ ...board, cards: board.cards.map((c) => (snap[c.id] ? { ...c, x: snap[c.id].x, y: snap[c.id].y } : c)) });

  const api = { layout, placeNew, onLoad, looksUnarranged, unplaced, snapshot, restore, GAP_X, GAP_Y };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.BoardLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
