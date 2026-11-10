// Background effects behind the terminal text. A canvas sits under xterm (whose own background is always transparent), so the effect
// shows even with the page transparency at 0; the canvas never takes mouse or keyboard input. Each effect is a small module in
// public/fx/ with the same three calls: start(canvas, { animate }), stop(), resize(). To add one: a new file there plus its name in
// src/fx.js. Effects are loaded on first use, so a page without an effect costs nothing.
const LOADERS = { matrix: () => import('./fx/matrix.js'), rain: () => import('./fx/rain.js') };

/** True when the user asked the system for less motion: effects then draw one still frame. */
export const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function createFx({ canvas, root = document.documentElement, onChange = () => {} }) {
  let current = null; let want = null; let ro = null;
  async function set(name) {
    want = name || null;
    if (current) { current.stop(); current = null; ro?.disconnect(); ro = null; }
    root.classList.remove('has-fx'); onChange(null);
    if (!want || !LOADERS[want]) return;
    let mod;
    try { mod = (await LOADERS[want]()).default; } catch (e) { console.warn(`fx ${want} could not load: ${e.message}`); return; }
    if (want !== name) return; // a newer request arrived while the module loaded
    root.classList.add('has-fx'); // the canvas needs its size before start() reads it
    mod.start(canvas, { animate: !reducedMotion() });
    current = mod; onChange(want);
    ro = new ResizeObserver(() => mod.resize()); ro.observe(canvas);
  }
  return { set, active: () => (current ? current.name : null) };
}
