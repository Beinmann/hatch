// Background effects behind the terminal text. A canvas sits under xterm (whose own background is always transparent), so the effect
// shows even with the page transparency at 0; the canvas never takes mouse or keyboard input. Each effect is a small module in
// public/fx/ with the same calls: start(canvas, { animate, intensity, terminal }), setIntensity(n), stop(), resize(). `intensity` is
// 0..100 (50 = the default look); `terminal` is a read-only view of the xterm screen (public/fx-terminal.js) or null, and effects that
// do not need it ignore it. To add one: a new file there plus its name in src/fx.js. Effects are loaded on first use.
import { terminalAdapter } from './fx-terminal.js';
const LOADERS = { matrix: () => import('./fx/matrix.js'), rain: () => import('./fx/rain.js'), goo: () => import('./fx/goo.js') };

/** True when the user asked the system for less motion: effects then draw one still frame. */
export const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** getXterm() returns the xterm instance (or null when there is none yet); it is called at each start. */
export function createFx({ canvas, root = document.documentElement, onChange = () => {}, getXterm = () => null }) {
  let current = null; let want = null; let intensity = 50; let ro = null; let adapter = null; let token = 0;
  function teardown() {
    if (current) { current.stop(); current = null; }
    ro?.disconnect(); ro = null; adapter?.dispose(); adapter = null;
  }
  /** Shows effect `name` (null = none) at `level`. The same effect with a new level only changes the level, live. */
  async function set(name, level) {
    const next = name || null;
    if (Number.isFinite(level)) intensity = level;
    if (next && next === want) { current?.setIntensity?.(intensity); return; } // same effect (running, or still loading): nothing to restart
    want = next; const mine = ++token;
    teardown(); root.classList.remove('has-fx'); onChange(null);
    if (!want || !LOADERS[want]) return;
    let mod;
    try { mod = (await LOADERS[want]()).default; } catch (e) { console.warn(`fx ${want} could not load: ${e.message}`); if (mine === token) want = null; return; }
    if (mine !== token) return; // a newer request arrived while the module loaded
    root.classList.add('has-fx'); // the canvas needs its size before start() reads it
    let xterm = null; try { xterm = getXterm(); } catch { /* no terminal yet */ }
    try { adapter = xterm ? terminalAdapter(xterm, canvas) : null; } catch (e) { console.warn(`fx terminal view unavailable: ${e.message}`); adapter = null; }
    mod.start(canvas, { animate: !reducedMotion(), intensity, terminal: adapter });
    current = mod; onChange(want);
    ro = new ResizeObserver(() => mod.resize()); ro.observe(canvas);
  }
  return { set, active: () => (current ? current.name : null) };
}
