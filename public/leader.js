// Leader (prefix) key, tmux style: press the leader chord, then one key. This file holds the pure parts
// (chord parsing, which key means which action) so they can be tested; the state machine is in app.js.
export const DEFAULT_LEADER = 'Ctrl+Space';
export const REPEAT_MS = 800; // like tmux repeat-time: focus, move and resize keys keep the leader armed this long

const NAMED = { space: 'Space', tab: 'Tab', enter: 'Enter', esc: 'Escape', escape: 'Escape', backquote: 'Backquote', '`': 'Backquote' };
// "Ctrl+Space", "Ctrl+A", "Alt+Space" -> { ctrl, alt, shift, meta, code }; null when it cannot be used (needs a modifier and a key).
export function parseChord(text) {
  const parts = String(text || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const chord = { ctrl: false, alt: false, shift: false, meta: false, code: '' };
  for (const p of parts.slice(0, -1)) {
    const m = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'meta', cmd: 'meta', super: 'meta' }[p.toLowerCase()];
    if (!m) return null;
    chord[m] = true;
  }
  const key = parts[parts.length - 1]; const low = key.toLowerCase();
  chord.code = NAMED[low] || (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : /^F\d{1,2}$/i.test(key) ? key.toUpperCase() : '');
  if (!chord.code || !(chord.ctrl || chord.alt || chord.meta)) return null;
  return chord;
}
// Return by what the OS delivers (e.key) so a key remapped to Return works; code covers Enter and numpad Enter.
export const isEnter = (e) => e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
export const chordMatches = (c, e) => !!c && e.code === c.code && !!e.ctrlKey === c.ctrl && !!e.altKey === c.alt && !!e.shiftKey === c.shift && !!e.metaKey === c.meta;

const DIRS = { KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l', ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l' };
const PLAIN = { Tab: 'next', KeyT: 'terminal', KeyQ: 'close', KeyM: 'minimize', KeyU: 'dock', KeyF: 'maximize', KeyA: 'tile', KeyP: 'palette', KeyO: 'opacity', Escape: 'cancel' };
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
// The key after the leader -> { action, dir?, n?, repeat } or null (unbound: cancels). Pure modifier presses return 'ignore'
// so Ctrl or Shift can be pressed before h/j/k/l without cancelling.
export function leaderAction(e) {
  if (MODIFIERS.has(e.key)) return { action: 'ignore' };
  if (e.altKey || e.metaKey) return null;
  const dir = DIRS[e.code];
  if (dir) {
    if (e.ctrlKey && !e.shiftKey) return { action: 'resize', dir, repeat: true };
    if (e.shiftKey && !e.ctrlKey) return { action: 'move', dir, repeat: true };
    if (!e.ctrlKey && !e.shiftKey) return { action: 'focus', dir, repeat: true };
    return null;
  }
  if (e.ctrlKey) return null;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (digit && !e.shiftKey) return { action: 'number', n: Number(digit[1]), repeat: false };
  if (isEnter(e) && !e.shiftKey) return { action: 'terminal', repeat: false }; // same as t; the dock step handles its own Return before this
  const action = PLAIN[e.code];
  if (!action || (e.shiftKey && action !== 'next')) return null;
  return { action, repeat: action === 'next' };
}
