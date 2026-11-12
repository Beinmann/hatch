// Scratchpad data model (prototype): pure functions on a plain board object, no DOM. Boards are never mutated; every
// function returns a new board. Loaded as a classic script in the widget (window.ScratchModel) and by node tests.
(function (root) {
  const CARD_W = 180, CARD_H = 100, MIN_ZOOM = 0.2, MAX_ZOOM = 3;

  const empty = () => ({ version: 1, cards: [], arrows: [], view: { x: 0, y: 0, zoom: 1 }, nextId: 1 });
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** Turns whatever was read from the file into a valid board: bad entries are dropped, never thrown on. */
  function sanitize(raw) {
    const b = empty();
    if (!raw || typeof raw !== 'object') return b;
    const ids = new Set();
    for (const c of Array.isArray(raw.cards) ? raw.cards : []) {
      if (!c || typeof c.id !== 'string' || ids.has(c.id)) continue;
      ids.add(c.id);
      b.cards.push({ id: c.id, x: num(c.x, 0), y: num(c.y, 0), w: clamp(num(c.w, CARD_W), 80, 800), h: clamp(num(c.h, CARD_H), 50, 800), text: typeof c.text === 'string' ? c.text.slice(0, 20000) : '' });
    }
    const seen = new Set();
    for (const a of Array.isArray(raw.arrows) ? raw.arrows : []) {
      if (!a || typeof a.id !== 'string' || !ids.has(a.from) || !ids.has(a.to) || a.from === a.to) continue;
      const k = a.from + '>' + a.to; if (seen.has(k) || seen.has('id:' + a.id)) continue;
      seen.add(k); seen.add('id:' + a.id); b.arrows.push({ id: a.id, from: a.from, to: a.to });
    }
    const v = raw.view || {};
    b.view = { x: num(v.x, 0), y: num(v.y, 0), zoom: clamp(num(v.zoom, 1), MIN_ZOOM, MAX_ZOOM) };
    // ids look like "c7"/"a3": keep nextId above every number in use so a reload never reissues an id
    let max = 0; for (const o of [...b.cards, ...b.arrows]) max = Math.max(max, parseInt(o.id.slice(1), 10) || 0);
    b.nextId = Math.max(max + 1, num(raw.nextId, 1));
    return b;
  }

  const parse = (text) => { try { return sanitize(JSON.parse(text)); } catch { return empty(); } };
  const serialize = (b) => JSON.stringify(b);

  function addCard(b, x, y, text = '') {
    const id = 'c' + b.nextId;
    return { board: { ...b, nextId: b.nextId + 1, cards: [...b.cards, { id, x: Math.round(x - CARD_W / 2), y: Math.round(y - 20), w: CARD_W, h: CARD_H, text }] }, id };
  }
  const patchCard = (b, id, p) => ({ ...b, cards: b.cards.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const moveCard = (b, id, x, y) => patchCard(b, id, { x: Math.round(x), y: Math.round(y) });
  const setText = (b, id, text) => patchCard(b, id, { text: String(text) });
  const removeCard = (b, id) => ({ ...b, cards: b.cards.filter((c) => c.id !== id), arrows: b.arrows.filter((a) => a.from !== id && a.to !== id) });

  /** Adds an arrow unless it would be a self loop, duplicate, or touch an unknown card. Returns {board, id|null}. */
  function addArrow(b, from, to) {
    const has = (id) => b.cards.some((c) => c.id === id);
    if (from === to || !has(from) || !has(to) || b.arrows.some((a) => a.from === from && a.to === to)) return { board: b, id: null };
    const id = 'a' + b.nextId;
    return { board: { ...b, nextId: b.nextId + 1, arrows: [...b.arrows, { id, from, to }] }, id };
  }
  const removeArrow = (b, id) => ({ ...b, arrows: b.arrows.filter((a) => a.id !== id) });

  const setView = (b, view) => ({ ...b, view: { x: view.x, y: view.y, zoom: clamp(view.zoom, MIN_ZOOM, MAX_ZOOM) } });
  const toWorld = (view, sx, sy) => ({ x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom });
  /** New view after zooming by `factor` with the world point under screen point (sx, sy) staying put. */
  function zoomAt(view, sx, sy, factor) {
    const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM); const k = zoom / view.zoom;
    return { x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k, zoom };
  }

  /** Where the line from a card's centre towards (tx, ty) leaves the card's rectangle. */
  function edgePoint(card, tx, ty) {
    const cx = card.x + card.w / 2, cy = card.y + card.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = Math.min(dx ? (card.w / 2) / Math.abs(dx) : Infinity, dy ? (card.h / 2) / Math.abs(dy) : Infinity);
    return { x: cx + dx * s, y: cy + dy * s };
  }
  /** Line segment of an arrow, edge to edge, or null if a card is missing. */
  function arrowLine(b, a) {
    const f = b.cards.find((c) => c.id === a.from), t = b.cards.find((c) => c.id === a.to);
    if (!f || !t) return null;
    const p = edgePoint(f, t.x + t.w / 2, t.y + t.h / 2), q = edgePoint(t, f.x + f.w / 2, f.y + f.h / 2);
    return { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
  }
  /** Topmost card (last in the list) containing the world point, or null. */
  function cardAt(b, x, y) {
    for (let i = b.cards.length - 1; i >= 0; i--) { const c = b.cards[i]; if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c; }
    return null;
  }
  /** Moves a card to the end of the list so it draws on top. */
  const raise = (b, id) => { const c = b.cards.find((k) => k.id === id); return c ? { ...b, cards: [...b.cards.filter((k) => k.id !== id), c] } : b; };

  /** The text is saved in chunks (hatch.call arguments are short). ASCII-only JSON so a cut can never split a character. */
  function chunks(b, size = 3000) {
    const s = serialize(b).replace(/[\u007f-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    const out = []; for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size)); return out;
  }

  const api = { CARD_W, CARD_H, empty, sanitize, parse, serialize, addCard, moveCard, setText, patchCard, removeCard, addArrow, removeArrow, setView, toWorld, zoomAt, edgePoint, arrowLine, cardAt, raise, chunks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ScratchModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
