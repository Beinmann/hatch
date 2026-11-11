// A small, read-only view of the xterm instance for background effects that want to anchor to the text on screen. Only public xterm
// APIs (buffer.active, onRender/onScroll/onResize, element) plus the DOM size of the screen element are used, no private internals.
// Positions are CSS px relative to the effect canvas, which is the same as canvas px (the canvas runs at device pixel ratio 1).
const THROTTLE_MS = 200; // change events (a render per output chunk) are coalesced so an effect never re-reads the screen more than ~5x/s
const MAX_CELLS = 20000; // cap on cells read per cellsWithText() call (a 200x100 screen)

export function terminalAdapter(xterm, canvas) {
  const subs = []; let timer = 0, pending = false, last = 0, disposed = false;
  const cbs = new Set();
  const fire = () => { pending = false; last = Date.now(); if (!disposed) for (const cb of cbs) { try { cb(); } catch (e) { console.warn(`fx terminal listener failed: ${e.message}`); } } };
  const poke = () => { // leading edge now, then at most one more call per THROTTLE_MS
    if (disposed || pending) return;
    const wait = THROTTLE_MS - (Date.now() - last);
    if (wait <= 0) fire(); else { pending = true; timer = setTimeout(fire, wait); }
  };
  const hook = (ev) => { try { if (typeof xterm[ev] === 'function') subs.push(xterm[ev](poke)); } catch { /* an older xterm without this event */ } };
  hook('onRender'); hook('onScroll'); hook('onResize');
  const buf = () => xterm.buffer?.active;
  const ad = {
    get cols() { return xterm.cols || 0; },
    get rows() { return xterm.rows || 0; },
    /** { w, h, left, top }: one cell and where the cell grid starts, relative to the canvas. w or h 0 = not measurable yet. */
    cellSize() {
      const screen = xterm.element?.querySelector?.('.xterm-screen');
      if (!screen || !xterm.cols || !xterm.rows) return { w: 0, h: 0, left: 0, top: 0 };
      const s = screen.getBoundingClientRect(), c = canvas.getBoundingClientRect();
      return { w: s.width / xterm.cols, h: s.height / xterm.rows, left: s.left - c.left, top: s.top - c.top };
    },
    viewportY: () => buf()?.viewportY ?? 0,
    /** The character in a visible cell ('' when empty); row 0 is the top visible row. */
    charAt(col, row) {
      const b = buf(); const line = b?.getLine(b.viewportY + row); const cell = line?.getCell(col);
      const ch = cell?.getChars?.() ?? ''; return ch === ' ' ? '' : ch;
    },
    /** Visible cells that hold a non-space character: [{ col, row, ch }], at most `max`, top to bottom. */
    cellsWithText(max = MAX_CELLS) {
      const b = buf(); const out = []; if (!b) return out;
      const cell = b.getNullCell(); const rows = Math.min(xterm.rows, Math.floor(MAX_CELLS / Math.max(1, xterm.cols)));
      for (let r = 0; r < rows && out.length < max; r++) {
        const line = b.getLine(b.viewportY + r); if (!line) continue;
        const n = Math.min(xterm.cols, line.length);
        for (let c = 0; c < n && out.length < max; c++) { const x = line.getCell(c, cell); const ch = x?.getChars(); if (ch && ch !== ' ') out.push({ col: c, row: r, ch }); }
      }
      return out;
    },
    /** cb() after the screen rendered, scrolled or resized (throttled). Returns an unsubscribe function. */
    onChange(cb) { cbs.add(cb); return () => cbs.delete(cb); },
    dispose() { disposed = true; clearTimeout(timer); for (const s of subs) { try { s?.dispose?.(); } catch { /* gone already */ } } subs.length = 0; cbs.clear(); },
  };
  return ad;
}
