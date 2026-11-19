import test from 'node:test';
import assert from 'node:assert/strict';
import { chipClickAction, createChipPress, windowFocused } from '../public/chip-click.js';

test('minimized chip restores, whatever else is true', () => {
  assert.equal(chipClickAction({ minimized: true, onScreen: false, focused: false }), 'restore');
  assert.equal(chipClickAction({ minimized: true, onScreen: true, focused: true }), 'restore');
});
test('focused window on screen minimizes', () => {
  assert.equal(chipClickAction({ minimized: false, onScreen: true, focused: true }), 'minimize');
});
test('visible but unfocused, or hidden (closed dock), gets focus', () => {
  assert.equal(chipClickAction({ minimized: false, onScreen: true, focused: false }), 'focus');
  assert.equal(chipClickAction({ minimized: false, onScreen: false, focused: true }), 'focus');
});

test('focused state is captured on pointerdown and wins over a later live value', () => {
  const p = createChipPress();
  p.down('a', true);
  assert.equal(p.focusedAt('a', false), true); // focus already moved off the window by the click
  p.down('b', false);
  assert.equal(p.focusedAt('b', true), false);
  assert.equal(p.focusedAt('c', true), true); // keyboard click: no press, use the live state
});
test('a press ends cleanly and forgets the captured state', () => {
  const p = createChipPress();
  p.down('a', true); p.up();
  assert.equal(p.focusedAt('a', false), false);
});
test('repaints are deferred during a press and reported afterwards', () => {
  const p = createChipPress();
  assert.equal(p.deferPaint(), false);
  p.down('a', false);
  assert.equal(p.deferPaint(), true);
  assert.equal(p.up(), true);
  assert.equal(p.up(), false);
  assert.equal(p.deferPaint(), false);
});
test('windowFocused: focus class or real focus inside the window', () => {
  const node = (cls, inside) => ({ classList: { contains: (c) => c === 'focus' && cls }, contains: (x) => x === inside });
  assert.equal(windowFocused(node(true, null), null), true);
  assert.equal(windowFocused(node(false, 'frame'), 'frame'), true);
  assert.equal(windowFocused(node(false, 'frame'), 'other'), false);
  assert.equal(windowFocused(null, null), false);
});

test('number key: Ctrl+N minimizes a window that is already open, restores a minimized one', async () => {
  const { numberKeyAction } = await import('../public/chip-click.js');
  assert.equal(numberKeyAction({ minimized: true, onScreen: false, toggle: true }), 'restore');
  assert.equal(numberKeyAction({ minimized: false, onScreen: true, toggle: true }), 'minimize');
  assert.equal(numberKeyAction({ minimized: false, onScreen: false, toggle: true }), 'focus', 'docked with the dock closed: bring it forward');
  assert.equal(numberKeyAction({ minimized: false, onScreen: true, toggle: false }), 'focus', 'leader + number never minimizes');
});
