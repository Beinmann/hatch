import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChord, chordMatches, leaderAction, isEnter } from '../public/leader.js';

test('parseChord reads modifier chords and rejects unusable ones', () => {
  assert.deepEqual(parseChord('Ctrl+Space'), { ctrl: true, alt: false, shift: false, meta: false, code: 'Space' });
  assert.equal(parseChord('ctrl+a').code, 'KeyA');
  assert.equal(parseChord('Space'), null, 'a bare key would steal normal typing');
  assert.equal(parseChord('Shift+A'), null, 'shift alone would steal capital letters');
  assert.equal(parseChord('Hyper+A'), null);
  assert.equal(parseChord(''), null);
});

test('chordMatches is exact about modifiers', () => {
  const c = parseChord('Ctrl+Space');
  assert.ok(chordMatches(c, { code: 'Space', ctrlKey: true }));
  assert.ok(!chordMatches(c, { code: 'Space', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Space is not the leader');
  assert.ok(!chordMatches(c, { code: 'Space' }));
});

test('leaderAction maps every key of the table', () => {
  const k = (code, o = {}) => leaderAction({ code, key: o.key || code, ...o });
  assert.deepEqual(k('KeyH'), { action: 'focus', dir: 'h', repeat: true });
  assert.deepEqual(k('ArrowDown'), { action: 'focus', dir: 'j', repeat: true });
  assert.deepEqual(k('KeyK', { shiftKey: true }), { action: 'move', dir: 'k', repeat: true });
  assert.deepEqual(k('ArrowLeft', { ctrlKey: true }), { action: 'resize', dir: 'h', repeat: true });
  assert.deepEqual(k('Digit3'), { action: 'number', n: 3, repeat: false });
  for (const [code, action] of [['KeyT', 'terminal'], ['KeyQ', 'close'], ['KeyM', 'minimize'], ['KeyD', 'place'], ['KeyU', 'dock'], ['KeyF', 'maximize'], ['KeyA', 'tile'], ['KeyP', 'palette'], ['Tab', 'next']]) assert.equal(k(code).action, action);
  assert.equal(k('KeyT').repeat, false, 'action keys are one-shot');
  assert.equal(k('Control', { key: 'Control', ctrlKey: true }).action, 'ignore', 'pressing Ctrl before h must not cancel');
  assert.equal(k('KeyZ'), null, 'unbound keys cancel');
  assert.equal(k('KeyQ', { altKey: true }), null);
  assert.equal(k('Digit0'), null);
});

test('leader d docks or releases the focused window, Shift+d is show desktop', () => {
  assert.deepEqual(leaderAction({ code: 'KeyD', key: 'D', shiftKey: true }), { action: 'desktop', repeat: false });
  assert.deepEqual(leaderAction({ code: 'KeyD', key: 'd' }), { action: 'place', repeat: false });
  assert.equal(leaderAction({ code: 'KeyD', key: 'D', shiftKey: true, ctrlKey: true }), null);
  assert.equal(leaderAction({ code: 'KeyD', key: 'D', shiftKey: true, altKey: true }), null);
  assert.equal(leaderAction({ code: 'KeyU', key: 'U', shiftKey: true }), null, 'other shifted letters stay unbound');
});

test('leader o asks for the transparency of the focused window', () => {
  assert.deepEqual(leaderAction({ code: 'KeyO', key: 'o' }), { action: 'opacity', repeat: false });
  assert.equal(leaderAction({ code: 'BracketLeft', key: '[' }), null);
  assert.equal(leaderAction({ code: 'KeyO', key: 'O', shiftKey: true }), null);
});

test('isEnter accepts a key remapped to Return, real Return and numpad Enter', () => {
  assert.equal(isEnter({ key: 'Enter', code: 'KeyX' }), true, 'OS remap: key is Enter, code is the physical key');
  assert.equal(isEnter({ key: 'Enter', code: 'Enter' }), true);
  assert.equal(isEnter({ key: 'Enter', code: 'NumpadEnter' }), true);
  assert.equal(isEnter({ key: 'x', code: 'KeyX' }), false);
});

test('leader Return focuses the terminal like t, also for a key remapped to Return', () => {
  assert.deepEqual(leaderAction({ code: 'Enter', key: 'Enter' }), { action: 'terminal', repeat: false });
  assert.deepEqual(leaderAction({ code: 'NumpadEnter', key: 'Enter' }), { action: 'terminal', repeat: false });
  assert.deepEqual(leaderAction({ code: 'CapsLock', key: 'Enter' }), { action: 'terminal', repeat: false });
  assert.equal(leaderAction({ code: 'Enter', key: 'Enter', ctrlKey: true }), null);
});
