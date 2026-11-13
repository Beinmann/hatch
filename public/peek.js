// "Peek": hold a modifier (default Alt) ALONE and the floating windows are hidden so what is behind them can be read;
// release and everything is back exactly as it was. This file is the pure state machine (timers are injected so it can be
// tested without a browser); app.js wires it to key events and toggles a CSS class on <body>.
export const DEFAULT_PEEK = 'Alt';
export const PEEK_DELAY_MS = 180; // Alt must be held this long with no other key before anything hides, so Alt+key chords never flash
export const PEEK_KEYS = ['Alt', 'Control', 'Shift', 'Meta']; // modifiers that may be used; anything else (or 'off') disables peek
export const peekKeyOrNull = (name) => (PEEK_KEYS.includes(name) ? name : null);

/** onChange(boolean) is called whenever the peeking state flips. getKey() returns the configured key name (e.key value) or null.
 *  Feed it keydown/keyup events (anything with .key and .repeat) and call reset() on blur / visibilitychange / focus loss.
 *  keyup() returns true when the release ended a peek, so the caller can preventDefault (stops the browser menu bar taking focus). */
export function createPeek({ onChange, getKey = () => DEFAULT_PEEK, delay = PEEK_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let down = false; let timer = null; let on = false;
  const set = (v) => { if (on !== v) { on = v; onChange(v); } };
  const stop = () => { down = false; if (timer !== null) { clearTimer(timer); timer = null; } set(false); };
  return {
    get active() { return on; },
    keydown(e) {
      const key = getKey();
      if (e.key !== key) { if (down || on) stop(); return; } // any other key (a chord, or another modifier) ends it
      if (e.repeat || down) return; // auto-repeat of the held key: ignore
      down = true;
      timer = setTimer(() => { timer = null; if (down) set(true); }, delay);
    },
    keyup(e) {
      if (e.key !== getKey() || !down) return false;
      const wasOn = on; stop(); return wasOn;
    },
    reset: stop,
  };
}
