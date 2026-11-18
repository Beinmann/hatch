import test from 'node:test';
import assert from 'node:assert/strict';
import { chipClickAction } from '../public/chip-click.js';

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
