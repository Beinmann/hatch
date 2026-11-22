// Tide data model: pure functions on a plain state object, no DOM. States are never mutated; every function returns a
// new state. Loaded as a classic script in the widget (window.TideModel) and by node tests.
//
// One state = one day. Times are minutes since local midnight (0..1440). A card is either loose (s === null, free
// position x/y in the pool above the timeline) or placed (s = start minute on the timeline, always a multiple of 15).
(function (root) {
  const DAY = 1440, STEP = 15, MIN_LEN = 15, MAX_LEN = 480, DEFAULT_LEN = 30, DEFAULT_WALL = 1320;
  const DEFAULT_CATS = [
    { id: 'a', name: 'home', color: '#f0b36a' }, { id: 'b', name: 'work', color: '#5fd0c4' },
    { id: 'c', name: 'projects', color: '#a99bf0' }, { id: 'd', name: 'errands', color: '#f08fa8' },
  ];
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (m) => { m = Math.max(0, Math.min(DAY - 1, Math.round(m))); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const fmt = (m) => { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`; };
  const dayId = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const snap = (m) => Math.round(m / STEP) * STEP;
  const lenOf = (n) => Math.max(MIN_LEN, Math.min(MAX_LEN, snap(Number.isFinite(+n) ? +n : DEFAULT_LEN)));
  const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  const int = (v, lo, hi, dflt) => { const n = Math.round(+v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

  function empty(day = dayId(), keep) {
    return { v: 1, day, wall: keep?.wall ?? DEFAULT_WALL, cats: keep?.cats ? keep.cats.map((c) => ({ ...c })) : DEFAULT_CATS.map((c) => ({ ...c })), cards: [], goals: [], plan: null, seq: 1 };
  }

  function sanitizeCard(c, catIds) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[\w-]{1,40}$/.test(c.id)) return null;
    const placed = c.s !== null && c.s !== undefined && Number.isFinite(+c.s);
    const out = {
      id: c.id, t: str(c.t, 300), cat: catIds.has(c.cat) ? c.cat : null, len: lenOf(c.len),
      s: placed ? snap(int(c.s, 0, DAY - MIN_LEN, 0)) : null, x: int(c.x, -5000, 5000, 0), y: int(c.y, -5000, 5000, 0),
    };
    if (c.done) out.done = true;
    if (c.locked && placed) out.locked = true;
    if (Number.isFinite(+c.took) && +c.took > 0) out.took = int(c.took, 1, 1440, 0);
    if (Array.isArray(c.steps)) { const s = c.steps.filter((x) => typeof x === 'string' && x).slice(0, 12).map((x) => x.slice(0, 200)); if (s.length) out.steps = s; }
    if (typeof c.q === 'string' && c.q) out.q = c.q.slice(0, 200);
    if (typeof c.goal === 'string' && c.goal) out.goal = c.goal.slice(0, 40);
    if (typeof c.part === 'string' && c.part) out.part = c.part.slice(0, 12);
    if (c.raw) out.raw = true;
    return out;
  }

  /** Any JSON (a file written by hand or by an AI) becomes a valid state; unknown fields are dropped. `day` is the fallback. */
  function sanitize(o, day = dayId()) {
    const base = empty(typeof o?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.day) ? o.day : day);
    if (!o || typeof o !== 'object') return base;
    base.wall = int(o.wall, 12 * 60, DAY, DEFAULT_WALL);
    if (Array.isArray(o.cats)) {
      const cats = []; const seen = new Set();
      for (const c of o.cats) {
        if (!c || typeof c.id !== 'string' || !/^[\w-]{1,20}$/.test(c.id) || seen.has(c.id)) continue;
        seen.add(c.id); cats.push({ id: c.id, name: str(c.name, 30) || c.id, color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#93a4a9' });
      }
      if (cats.length) base.cats = cats.slice(0, 12);
    }
    const catIds = new Set(base.cats.map((c) => c.id)); const ids = new Set();
    for (const c of Array.isArray(o.cards) ? o.cards : []) { const k = sanitizeCard(c, catIds); if (k && !ids.has(k.id)) { ids.add(k.id); base.cards.push(k); } }
    const goalIds = new Set();
    for (const g of Array.isArray(o.goals) ? o.goals : []) {
      if (!g || typeof g.id !== 'string' || !/^[\w-]{1,40}$/.test(g.id) || goalIds.has(g.id)) continue;
      goalIds.add(g.id); base.goals.push({ id: g.id, t: str(g.t, 300), cat: catIds.has(g.cat) ? g.cat : null, len: lenOf(g.len) });
    }
    for (const c of base.cards) if (c.goal && !goalIds.has(c.goal)) delete c.goal;
    if (o.plan && typeof o.plan === 'object' && o.plan.m && typeof o.plan.m === 'object') {
      const m = {}; for (const [k, v] of Object.entries(o.plan.m)) if (v && Number.isFinite(+v.s) && Number.isFinite(+v.len)) m[k] = { s: snap(int(v.s, 0, DAY, 0)), len: lenOf(v.len) };
      base.plan = { at: str(o.plan.at, 5) || '00:00', m };
    }
    base.seq = Math.max(int(o.seq, 1, 1e9, 1), base.cards.length + base.goals.length + 1);
    return base;
  }

  const card = (st, id) => st.cards.find((c) => c.id === id);
  const withCards = (st, cards, extra) => ({ ...st, cards, ...extra });
  const patchIn = (st, id, patch) => withCards(st, st.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const newId = (st, prefix) => `${prefix}${st.seq}`;

  /** The first free spot (row by row) for a loose card of `len` minutes; `opts`: px per minute, width/height of the pool, card height. */
  function freeSpot(st, len, opts = {}) {
    const px = opts.px || 3.2, W = opts.width || 1000, H = opts.height || 300, ch = opts.cardH || 88, gap = 8, left = opts.left ?? 12, top = opts.top ?? 44;
    const w = len * px - 6, rects = st.cards.filter((c) => c.s === null).map((c) => [c.x, c.y, c.len * px - 6, ch]);
    for (let y = top; y + ch <= H; y += ch + gap) for (let x = left; x + w <= W - 8; x += 24) {
      if (!rects.some(([rx, ry, rw, rh]) => x < rx + rw + gap && rx < x + w + gap && y < ry + rh + gap && ry < y + ch + gap)) return { x, y };
    }
    return { x: left, y: top };
  }

  function addCard(st, text, opts = {}) {
    const id = newId(st, 'c'); const len = lenOf(opts.len ?? DEFAULT_LEN);
    const spot = opts.x !== undefined ? { x: opts.x, y: opts.y } : freeSpot(st, len, opts);
    const c = { id, t: str(text, 300), cat: opts.cat ?? null, len, s: null, x: Math.round(spot.x), y: Math.round(spot.y), ...(opts.raw === false ? {} : { raw: true }) };
    return { state: { ...st, seq: st.seq + 1, cards: [...st.cards, c] }, id };
  }
  const setText = (st, id, t) => patchIn(st, id, { t: str(t, 300) });
  const setCat = (st, id, cat) => patchIn(st, id, { cat: st.cats.some((c) => c.id === cat) ? cat : null, raw: undefined });
  function removeCard(st, id) { return withCards({ ...st }, st.cards.filter((c) => c.id !== id)); }
  const moveLoose = (st, id, x, y) => patchIn(st, id, { s: null, locked: undefined, x: Math.round(x), y: Math.round(y) });
  const toggleDone = (st, id) => patchIn(st, id, { done: card(st, id)?.done ? undefined : true });
  const setTook = (st, id, min) => patchIn(st, id, { took: Number.isFinite(+min) && +min > 0 ? int(min, 1, 1440, 0) : undefined });
  const setLocked = (st, id, on) => { const c = card(st, id); return c && c.s !== null ? patchIn(st, id, { locked: on ? true : undefined }) : st; };

  /** Puts a card on the timeline at `s`, then shoves neighbours (see settle). */
  function place(st, id, s) {
    const c = card(st, id); if (!c || c.locked) return st;
    const len = c.len, start = Math.max(0, Math.min(DAY - len, snap(s)));
    return settle(patchIn(st, id, { s: start, raw: undefined }), id);
  }
  function resize(st, id, len) {
    const c = card(st, id); if (!c || c.locked) return st;
    const next = patchIn(st, id, { len: lenOf(len) });
    return c.s === null ? next : settle(next, id);
  }

  /** Resolves overlaps on the timeline. Done and locked cards never move. The card `bId` (just dropped or resized) keeps its
   *  place when it can: it goes behind an earlier-centred card it overlaps, and pushes later-centred ones right. The rest
   *  is pushed right in time order, jumping over locked cards. */
  function settle(st, bId) {
    const cs = st.cards.map((c) => ({ ...c }));
    const live = cs.filter((c) => c.s !== null && !c.done);
    const b = live.find((c) => c.id === bId && !c.locked);
    const locked = live.filter((c) => c.locked && c !== b);
    const mov = live.filter((c) => !c.locked && c !== b).sort((x, y) => x.s - y.s);
    const ov = (p, q) => p.s < q.s + q.len && q.s < p.s + p.len, mid = (c) => c.s + c.len / 2;
    if (b) {
      const dropMid = mid(b); // where it was dropped: it goes behind cards centred at or before this, whatever happens after it hops
      let moved = true, guard = 0;
      while (moved && guard++ < 60) { moved = false; for (const o of mov) if (ov(b, o) && mid(o) <= dropMid) { b.s = o.s + o.len; moved = true; } }
      for (const o of mov) if (ov(b, o) && mid(o) > mid(b)) o.s = b.s + b.len;
    }
    const seq = (b ? [...mov, b] : mov).sort((x, y) => x.s - y.s || (x === b ? -1 : 1));
    let end = -Infinity;
    for (const q of seq) {
      if (q.s < end) q.s = end;
      let hit, n = 0;
      while (n++ < 60 && (hit = locked.find((L) => q.s < L.s + L.len && L.s < q.s + q.len))) q.s = hit.s + hit.len;
      end = q.s + q.len;
    }
    return withCards(st, cs);
  }

  /** A card with at least `STEP` minutes per part is split into its steps (or two halves). The parent becomes a goal and
   *  disappears as a card; its parts keep a `goal` reference. Parts of a placed card follow each other from its start. */
  function split(st, id, opts = {}) {
    const c = card(st, id); if (!c || c.locked || c.done) return { state: st, ids: [] };
    const parts = c.steps && c.steps.length > 1 ? c.steps.slice() : [`${c.t} (1/2)`, `${c.t} (2/2)`];
    const n = parts.length, units = c.len / STEP;
    if (units < n) return { state: st, ids: [] };
    const base = Math.floor(units / n), rem = units - base * n;
    let seq = st.seq, goals = st.goals, goalId = c.goal, goalTitle = c.t;
    if (!goalId) { goalId = `g${seq++}`; goals = [...goals, { id: goalId, t: c.t, cat: c.cat, len: c.len }]; } else goalTitle = goals.find((g) => g.id === goalId)?.t ?? c.t;
    const px = opts.px || 3.2, W = opts.width || 1000, ch = opts.cardH || 88;
    const kids = []; let cum = 0, x = c.x, y = c.y;
    parts.forEach((t, i) => {
      const len = (base + (i === n - 1 ? rem : 0)) * STEP, kid = { id: `c${seq++}`, t: str(t, 300), cat: c.cat, len, s: c.s === null ? null : c.s + cum, x, y, goal: goalId, part: `${i + 1}/${n}` };
      if (c.s === null) { x += len * px + 8; if (x + len * px > W - 10) { x = c.x; y += ch + 8; } }
      kids.push(kid); cum += len;
    });
    const ids = kids.map((k) => k.id);
    let plan = st.plan;
    if (plan?.m[id]) { const m = { ...plan.m }; delete m[id]; kids.forEach((k) => { if (k.s !== null) m[k.id] = { s: k.s, len: k.len }; }); plan = { ...plan, m }; }
    const rest = st.cards.filter((k) => k.id !== id);
    const next = { ...st, seq, goals, plan, cards: [...rest, ...kids] };
    void goalTitle;
    return { state: c.s === null ? next : settle(next, null), ids };
  }

  /** The "Goals" overview: every goal that still has parts, with progress. Goals whose parts are all gone are dropped. */
  function goalsOverview(st) {
    return st.goals.map((g) => {
      const parts = st.cards.filter((c) => c.goal === g.id);
      return { id: g.id, t: g.t, cat: g.cat, parts: parts.map((p) => ({ id: p.id, t: p.t, done: !!p.done, placed: p.s !== null, len: p.len })), n: parts.length, done: parts.filter((p) => p.done).length, minutes: parts.reduce((a, p) => a + p.len, 0) };
    }).filter((g) => g.n > 0);
  }

  // ---- the plan snapshot: taken on request, compared with the timeline afterwards. Free rearranging never records anything.
  function lockPlan(st, atClock) {
    const m = {}; for (const c of st.cards) if (c.s !== null) m[c.id] = { s: c.s, len: c.len };
    return { ...st, plan: { at: atClock, m } };
  }
  const clearPlan = (st) => ({ ...st, plan: null });
  function planDiff(st) {
    if (!st.plan) return null;
    const keys = Object.keys(st.plan.m); const r = { at: st.plan.at, planned: keys.length, done: 0, moved: 0, added: 0, off: 0, longer: 0, ghosts: [] };
    for (const k of keys) {
      const p = st.plan.m[k], c = card(st, k);
      if (!c || c.s === null) { r.off++; r.ghosts.push({ id: k, s: p.s, len: p.len }); continue; }
      if (c.s !== p.s) { r.moved++; r.ghosts.push({ id: k, s: p.s, len: p.len }); }
      if (c.done) { r.done++; if (c.took && c.took > p.len) r.longer++; }
    }
    for (const c of st.cards) if (c.s !== null && !st.plan.m[c.id]) r.added++;
    return r;
  }

  /** Minutes left until the day ends, minutes of those not yet planned (`free`), and minutes of unfinished work that cross the end wall. */
  function load(st, now) {
    let planned = 0, over = 0;
    for (const c of st.cards) {
      if (c.s === null || c.done) continue;
      const e = c.s + c.len; planned += Math.max(0, Math.min(e, st.wall) - Math.max(c.s, now)); if (e > st.wall) over += e - Math.max(c.s, st.wall);
    }
    return { left: Math.max(0, st.wall - now), free: Math.max(0, st.wall - now - planned), over };
  }

  /** A state from an earlier day is archived and replaced by an empty one (categories and the day end carry over). */
  function rollDay(st, today) {
    if (st.day === today) return { state: st, archived: null };
    return { state: empty(today, st), archived: st.cards.length || st.goals.length ? st : null };
  }

  const serialize = (st) => JSON.stringify(st, (k, v) => (v === undefined ? undefined : v));
  /** The text is saved in chunks (hatch.call arguments are short). ASCII-only JSON so a cut can never split a character. */
  function chunks(st, size = 3000) {
    const s = serialize(st).replace(/[\u007f-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    const out = []; for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size)); return out;
  }

  // ---- categories (the colour legend) and the end of the day
  const HEX = /^#[0-9a-fA-F]{6}$/, EXTRA_COLORS = ['#e0c35a', '#7fb3e8', '#9bd17a', '#d48fe0'];
  function patchCat(st, id, p) {
    return { ...st, cats: st.cats.map((c) => (c.id !== id ? c : { ...c, ...(typeof p.name === 'string' && p.name.trim() && { name: str(p.name.trim(), 30) }), ...(HEX.test(p.color) && { color: p.color }) })) };
  }
  function addCat(st) {
    if (st.cats.length >= 12) return st;
    let n = 1; while (st.cats.some((c) => c.id === `n${n}`)) n++;
    return { ...st, cats: [...st.cats, { id: `n${n}`, name: 'new', color: EXTRA_COLORS[st.cats.length % EXTRA_COLORS.length] }] };
  }
  const setWall = (st, wall) => ({ ...st, wall: int(wall, 12 * 60, DAY, DEFAULT_WALL) });

  const api = { patchCat, addCat, setWall, DAY, STEP, MIN_LEN, MAX_LEN, DEFAULT_LEN, DEFAULT_CATS, clock, fmt, dayId, snap, lenOf, empty, sanitize, card, freeSpot, addCard, setText, setCat, removeCard, moveLoose, toggleDone, setTook, setLocked, place, resize, settle, split, goalsOverview, lockPlan, clearPlan, planDiff, load, rollDay, serialize, chunks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TideModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
