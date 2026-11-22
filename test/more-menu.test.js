import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moreMenuItems, showWorkspaceChips, menuFocusIndex } from '../public/more-menu.js';

const labels = (o) => moreMenuItems(o).map((i) => (i ? i.label : '-'));

test('one workspace: commands, progress, settings, new and rename; no switch entry', () => {
  assert.deepEqual(labels({ workspaces: 1 }), ['Commands', 'Settings', '-', 'New workspace', 'Rename workspace']);
  assert.deepEqual(labels({ workspaces: 1, progress: true }), ['Commands', 'Progress', 'Settings', '-', 'New workspace', 'Rename workspace']);
});
test('two or more workspaces add Switch workspace', () => {
  assert.deepEqual(labels({ workspaces: 2 }), ['Commands', 'Settings', '-', 'New workspace', 'Switch workspace', 'Rename workspace']);
});
test('view-only mirrors drop the commands and workspace entries', () => {
  assert.deepEqual(labels({ workspaces: 3, viewOnly: true }), ['Settings']);
});
test('entries keep the old button ids and show the shortcut hints', () => {
  const [pal, prog, set] = moreMenuItems({ progress: true });
  assert.deepEqual([pal.id, prog.id, set.id], ['palbtn', 'progressbtn', 'setbtn']);
  assert.equal(pal.hint, 'Ctrl+P'); assert.equal(prog.hint, 'Ctrl+Shift+G');
});
test('workspace chips only with two or more workspaces', () => {
  assert.equal(showWorkspaceChips(1), false); assert.equal(showWorkspaceChips(2), true);
});
test('arrow keys wrap around the entries', () => {
  assert.equal(menuFocusIndex('ArrowDown', -1, 3), 0);
  assert.equal(menuFocusIndex('ArrowDown', 2, 3), 0);
  assert.equal(menuFocusIndex('ArrowUp', 0, 3), 2);
  assert.equal(menuFocusIndex('ArrowUp', -1, 3), 2);
  assert.equal(menuFocusIndex('Home', 2, 3), 0); assert.equal(menuFocusIndex('End', 0, 3), 2);
  assert.equal(menuFocusIndex('a', 0, 3), -1); assert.equal(menuFocusIndex('ArrowDown', 0, 0), -1);
});
