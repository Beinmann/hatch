// Board data model (prototype): pure functions on a plain board object, no DOM. Boards are never mutated; every
// function returns a new board. Loaded as a classic script in the widget (window.ScratchModel) and by node tests.
(function (root) {
  const CARD_W = 180, CARD_H = 100, MIN_ZOOM = 0.2, MAX_ZOOM = 3;
  // Node types. An untyped card (every file written before types existed) is a sticky note. `size` is the default
  // [w, h], `min` the smallest the card can be resized to.
  const TYPES = {
    note: { label: 'Sticky note', size: [150, 110], min: [80, 50] },
    task: { label: 'Task card', size: [220, 130], min: [140, 80] },
    code: { label: 'Code snippet', size: [260, 110], min: [120, 60] },
    link: { label: 'Image / link card', size: [200, 160], min: [120, 100] },
    milestone: { label: 'Milestone pill', size: [150, 40], min: [90, 32] },
    group: { label: 'Group frame', size: [420, 240], min: [120, 80] },
    quote: { label: 'Quote', size: [210, 90], min: [100, 50] },
    board: { label: 'Board (nested)', size: [180, 130], min: [120, 90] },
  };
  const TYPE_ORDER = ['note', 'task', 'code', 'link', 'milestone', 'group', 'quote', 'board'];
  const DEFAULT_TYPE = 'note';
  const STATUSES = ['active', 'waiting', 'blocked', 'done']; // task chip: teal, amber, red, teal-filled
  const MILESTONE_STATES = ['todo', 'now', 'done'];
  const NOTE_COLORS = ['a', 'b', 'c']; // yellow, green, pink
  const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/; // child board ids end up in file names: nothing else is allowed
  const isType = (t) => Object.prototype.hasOwnProperty.call(TYPES, t);
  const oneOf = (v, list, d) => (list.includes(v) ? v : d);

  const empty = () => ({ version: 1, cards: [], arrows: [], view: { x: 0, y: 0, zoom: 1 }, nextId: 1 });
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function sanitizePreview(p) {
    return (Array.isArray(p) ? p : []).slice(0, 30).filter((r) => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every(Number.isFinite)).map((r) => [r[0], r[1], r[2], r[3], isType(r[4]) ? r[4] : DEFAULT_TYPE]);
  }

  /** Turns whatever was read from the file into a valid board: bad entries are dropped, never thrown on. */
  function sanitize(raw) {
    const b = empty();
    if (!raw || typeof raw !== 'object') return b;
    const ids = new Set();
    for (const c of Array.isArray(raw.cards) ? raw.cards : []) {
      if (!c || typeof c.id !== 'string' || ids.has(c.id)) continue;
      ids.add(c.id);
      let type = isType(c.type) ? c.type : DEFAULT_TYPE;
      if (type === 'board' && !(typeof c.childId === 'string' && BOARD_ID_RE.test(c.childId))) type = DEFAULT_TYPE; // a board card without a usable child is just text
      const t = TYPES[type];
      const card = { id: c.id, x: num(c.x, 0), y: num(c.y, 0), w: clamp(num(c.w, type === 'note' ? CARD_W : t.size[0]), t.min[0], 2000), h: clamp(num(c.h, type === 'note' ? CARD_H : t.size[1]), t.min[1], 2000), text: typeof c.text === 'string' ? c.text.slice(0, 20000) : '' };
      if (type !== DEFAULT_TYPE) card.type = type; // untyped stays untyped on disk: old files round-trip unchanged
      const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
      if (type === 'note' && NOTE_COLORS.includes(c.color) && c.color !== 'a') card.color = c.color;
      if (type === 'task' && STATUSES.includes(c.status)) card.status = c.status;
      if (type === 'milestone' && MILESTONE_STATES.includes(c.state)) card.state = c.state;
      if (type === 'code' && c.name) card.name = str(c.name, 80);
      if (type === 'link' && c.url) card.url = str(c.url, 2000);
      if (type === 'board') { card.childId = c.childId; card.count = Math.max(0, Math.floor(num(c.count, 0))); card.preview = sanitizePreview(c.preview); }
      b.cards.push(card);
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

  /** Adds a card of `type` centred horizontally on (x, y). A board card also gets a fresh child board id (`rng` only for tests). */
  function addCard(b, x, y, text = '', type = DEFAULT_TYPE, rng = Math.random) {
    if (!isType(type)) type = DEFAULT_TYPE;
    const id = 'c' + b.nextId, [w, h] = type === 'note' ? [CARD_W, CARD_H] : TYPES[type].size;
    const card = { id, x: Math.round(x - w / 2), y: Math.round(y - 20), w, h, text };
    if (type !== DEFAULT_TYPE) card.type = type;
    if (type === 'board') { card.childId = newBoardId(rng); card.count = 0; card.preview = []; }
    return { board: { ...b, nextId: b.nextId + 1, cards: [...b.cards, card] }, id };
  }
  const newBoardId = (rng = Math.random) => 'b' + Array.from({ length: 10 }, () => Math.floor(rng() * 36).toString(36)).join('');
  const typeOf = (c) => (c && isType(c.type) ? c.type : DEFAULT_TYPE);
  const patchCard = (b, id, p) => ({ ...b, cards: b.cards.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  const moveCard = (b, id, x, y) => patchCard(b, id, { x: Math.round(x), y: Math.round(y) });
  const setText = (b, id, text) => patchCard(b, id, { text: String(text) });
  const removeCard = (b, id) => ({ ...b, cards: b.cards.filter((c) => c.id !== id), arrows: b.arrows.filter((a) => a.from !== id && a.to !== id) });

  // Checklist lines inside a card's text: "- [ ] item" / "- [x] item" (also "*" bullets, indentation, capital X).
  const CHECK_RE = /^(\s*[-*]\s+\[)([ xX])(\](?:\s|$))/;
  /** Lines of a card text as [{text, check: null | {checked, label}}]; the index is the line number used by toggleCheck. */
  function lines(text) {
    return String(text == null ? '' : text).split('\n').map((t) => {
      const m = CHECK_RE.exec(t);
      return { text: t, check: m ? { checked: m[2] !== ' ', label: t.slice(m[0].length) } : null };
    });
  }
  /** {done, total} of the checklist lines in a text; total 0 means the card is plain text. */
  function progress(text) {
    const l = lines(text).filter((x) => x.check);
    return { done: l.filter((x) => x.check.checked).length, total: l.length };
  }
  /** Flips the checkbox on line `lineIndex` of a card's text. Anything that is not a checklist line leaves the board unchanged. */
  function toggleCheck(b, id, lineIndex) {
    const c = b.cards.find((k) => k.id === id); if (!c) return b;
    const ls = c.text.split('\n'); const m = CHECK_RE.exec(ls[lineIndex] == null ? '' : ls[lineIndex]); if (!m) return b;
    ls[lineIndex] = m[1] + (m[2] === ' ' ? 'x' : ' ') + ls[lineIndex].slice(m[1].length + 1);
    return setText(b, id, ls.join('\n'));
  }

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
    let frame = null; // a group frame only counts when nothing else is under the point
    for (let i = b.cards.length - 1; i >= 0; i--) {
      const c = b.cards[i]; if (!(x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)) continue;
      if (typeOf(c) !== 'group') return c; frame = frame || c;
    }
    return frame;
  }
  /** Ids of the cards that sit completely inside a group frame (they move with it); the frame itself is not included. */
  const groupMembers = (b, id) => {
    const g = b.cards.find((c) => c.id === id); if (!g || typeOf(g) !== 'group') return [];
    return b.cards.filter((c) => c.id !== id && c.x >= g.x && c.y >= g.y && c.x + c.w <= g.x + g.w && c.y + c.h <= g.y + g.h).map((c) => c.id);
  };
  /** Moves a card to the end of the list so it draws on top. */
  const raise = (b, id) => { const c = b.cards.find((k) => k.id === id); return c ? { ...b, cards: [...b.cards.filter((k) => k.id !== id), c] } : b; };

  // ---- nested boards. A board card points at a child board (its own file, own cards and view) by `childId`.
  /** Small cached look of a board for the card that points at it: card count and up to 30 rectangles. */
  const boardSummary = (b) => ({ count: b.cards.length, preview: b.cards.slice(0, 30).map((c) => [Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h), typeOf(c)]) });
  /** Refreshes the board card `cardId` in `b` from the child board it points at. */
  function setChildSummary(b, cardId, child) { const s = boardSummary(child); return patchCard(b, cardId, { count: s.count, preview: s.preview }); }
  /** True when entering or pasting `childId` while standing at `pathIds` (ids from the root down to the current board) would make a loop. */
  const wouldCycle = (pathIds, childId) => pathIds.includes(childId);
  /** The cards with `ids` plus the arrows between them, as a clipboard. */
  function clip(b, ids) {
    const set = new Set(ids), cards = b.cards.filter((c) => set.has(c.id));
    return { cards: cards.map((c) => ({ ...c })), arrows: b.arrows.filter((a) => set.has(a.from) && set.has(a.to)).map((a) => ({ ...a })) };
  }
  const removeCards = (b, ids) => { const set = new Set(ids); return { ...b, cards: b.cards.filter((c) => !set.has(c.id)), arrows: b.arrows.filter((a) => !set.has(a.from) && !set.has(a.to)) }; };
  /** Puts clipboard cards into a board with fresh ids, their top-left corner moved to (x, y). Board cards that would make a loop
   *  (their child is on `pathIds`) are left out and listed in `refused`. Returns {board, ids, refused}. */
  function paste(b, cb, x, y, pathIds = []) {
    const keep = (cb.cards || []).filter((c) => !(typeOf(c) === 'board' && wouldCycle(pathIds, c.childId)));
    const refused = (cb.cards || []).filter((c) => !keep.includes(c)).map((c) => c.id);
    if (!keep.length) return { board: b, ids: [], refused };
    const minX = Math.min(...keep.map((c) => c.x)), minY = Math.min(...keep.map((c) => c.y)), map = new Map();
    let next = b.nextId; const cards = keep.map((c) => { const id = 'c' + next++; map.set(c.id, id); return { ...c, id, x: Math.round(c.x - minX + x), y: Math.round(c.y - minY + y) }; });
    const arrows = (cb.arrows || []).filter((a) => map.has(a.from) && map.has(a.to)).map((a) => ({ id: 'a' + next++, from: map.get(a.from), to: map.get(a.to) }));
    return { board: { ...b, nextId: next, cards: [...b.cards, ...cards], arrows: [...b.arrows, ...arrows] }, ids: cards.map((c) => c.id), refused };
  }
  /** Moves the cards `ids` into a new child board. Returns {board, child, id} (id: the new board card), or null for an empty selection.
   *  Arrows between the moved cards go along, arrows to the rest are dropped. The child keeps the cards' ids and positions. */
  function wrap(b, ids, title = 'Board', rng = Math.random) {
    const cb = clip(b, ids); if (!cb.cards.length) return null;
    const x0 = Math.min(...cb.cards.map((c) => c.x)), x1 = Math.max(...cb.cards.map((c) => c.x + c.w)), y0 = Math.min(...cb.cards.map((c) => c.y)), y1 = Math.max(...cb.cards.map((c) => c.y + c.h));
    let child = { ...empty(), cards: cb.cards, arrows: cb.arrows, nextId: b.nextId };
    const r = addCard(removeCards(b, ids), (x0 + x1) / 2, (y0 + y1) / 2 + 20, title, 'board', rng);
    child = sanitize(child);
    return { board: setChildSummary(r.board, r.id, child), child, id: r.id };
  }

  // ---- code snippet tint: a tiny tokenizer (comments, strings, numbers, keywords, calls); good enough for a glance, not a parser
  const KEYWORDS = new Set('const let var function return if else for while do switch case break continue new class import export from default async await try catch throw typeof in of def lambda pass None True False null true false self echo then fi done elif'.split(' '));
  const TOKEN_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\()|([A-Za-z_$][\w$]*)/g;
  /** Splits code into [className, text] runs; className is '' (plain), 'c' comment, 's' string, 'n' number, 'k' keyword or 'f' call. Joining the texts gives the input back. */
  function tokenize(code) {
    const out = []; let last = 0; code = String(code == null ? '' : code);
    for (const m of code.matchAll(TOKEN_RE)) {
      if (m.index > last) out.push(['', code.slice(last, m.index)]);
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'f' : KEYWORDS.has(m[5]) ? 'k' : '';
      out.push([cls, m[0]]); last = m.index + m[0].length;
    }
    if (last < code.length) out.push(['', code.slice(last)]);
    return out;
  }
  /** A quote card's text: the last line that starts with an em dash or "--" is the source; the rest is the quote. */
  function splitQuote(text) {
    const ls = String(text == null ? '' : text).split('\n'), i = ls.length - 1;
    if (i > 0 && /^(\u2014|--)\s*\S/.test(ls[i])) return { quote: ls.slice(0, i).join('\n'), source: ls[i].replace(/^(\u2014|--)\s*/, '') };
    return { quote: ls.join('\n'), source: '' };
  }
  /** Image address of a link card, or '' when the address is not an http(s) or data image. */
  const imageUrl = (url) => (/^(https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|avif)([?#]\S*)?|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/i.test(String(url || '')) ? String(url) : '');
  /** Link address that is safe to open (http or https), or ''. */
  const linkUrl = (url) => (/^https?:\/\/[^\s<>"']+$/i.test(String(url || '')) ? String(url) : '');
  const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];

  /** The text is saved in chunks (hatch.call arguments are short). ASCII-only JSON so a cut can never split a character. */
  function chunks(b, size = 3000) {
    const s = serialize(b).replace(/[\u007f-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    const out = []; for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size)); return out;
  }

  const api = { tokenize, splitQuote, imageUrl, linkUrl, cycle, CARD_W, CARD_H, TYPES, TYPE_ORDER, DEFAULT_TYPE, STATUSES, MILESTONE_STATES, NOTE_COLORS, BOARD_ID_RE, typeOf, groupMembers, newBoardId, boardSummary, setChildSummary, wouldCycle, clip, removeCards, paste, wrap, empty, sanitize, parse, serialize, addCard, moveCard, setText, lines, progress, toggleCheck, patchCard, removeCard, addArrow, removeArrow, setView, toWorld, zoomAt, edgePoint, arrowLine, cardAt, raise, chunks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ScratchModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
