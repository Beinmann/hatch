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

// Palette shortcut: Ctrl+P works in Firefox and Chrome (preventDefault stops the print dialog). Ctrl+Shift+P is kept for
// Chrome but Firefox reserves it for a private window, so it is only a secondary route.
export const isPaletteKey = (e) => e.code === 'KeyP' && !!e.ctrlKey && !e.altKey && !e.metaKey;

/** Ctrl+Shift+Space returns focus to the terminal from anywhere (Firefox keeps Ctrl+` for itself; Ctrl+Space alone is the leader). */
export const isTermKey = (e) => e.code === 'Space' && !!e.ctrlKey && !!e.shiftKey && !e.altKey && !e.metaKey;
/** Ctrl+B (no other modifier): the tmux prefix. */
export const isPrefixKey = (e) => e.code === 'KeyB' && !!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
/** True for elements where the user types text (Ctrl+B belongs to them, not to tmux). `el` is a DOM element or null. */
export function isTextTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable || !!el.closest?.('.cm-editor, [contenteditable="true"], .xterm');
}

const DIRS = { KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l', ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l' };
const PLAIN = { Tab: 'next', KeyT: 'terminal', KeyQ: 'close', KeyM: 'minimize', KeyD: 'place', KeyU: 'dock', KeyS: 'toggledock', KeyF: 'maximize', KeyA: 'tile', KeyP: 'palette', KeyO: 'opacity', Escape: 'cancel' };
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
  if (!e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) return { action: e.code === 'BracketRight' ? 'wsnext' : 'wsprev', repeat: true }; // workspaces: ] next, [ previous
  if (e.code === 'KeyW' && !e.shiftKey) return { action: 'wsjump', repeat: false }; // then 1-9 picks a workspace, like 1-9 picks a window
  if (e.code === 'KeyD' && e.shiftKey) return { action: 'desktop', repeat: false }; // Shift+d: show desktop (plain d docks or releases the focused window)
  const action = PLAIN[e.code];
  if (!action || (e.shiftKey && action !== 'next')) return null;
  return { action, repeat: action === 'next' };
}
