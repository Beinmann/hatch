import test from 'node:test';
import assert from 'node:assert/strict';
import { formation, planShowDesktop, rememberMinimized } from '../public/show-desktop.js';

const P = (id, o = {}) => ({ id, placement: 'float', x: 10, y: 10, w: 300, h: 200, ...o });

test('first press minimizes every floating window of the shown workspace only', () => {
  const panels = [P('p1'), P('p2', { minimized: true }), P('p3', { ws: 'other' }), P('p4', { placement: 'dock' }), P('p5', { ws: 'other', sticky: true })];
  assert.deepEqual(planShowDesktop(panels, 'main', null), { action: 'minimize', ids: ['p1', 'p5'] });
  assert.deepEqual(planShowDesktop([P('p2', { minimized: true })], 'main', null), { action: 'none' });
});

test('second press restores when nothing changed, in focus order with the last focused window last', () => {
  const before = [P('p1'), P('p2', { maximized: true }), P('p3')];
  const plan = planShowDesktop(before, 'main', null, ['p3', 'p1']);
  const after = before.map((p) => ({ ...p, minimized: true })); const memo = rememberMinimized(after, 'main', plan.ids);
  const again = planShowDesktop(after, 'main', memo, ['p3', 'p1']);
  assert.equal(again.action, 'restore'); assert.deepEqual(again.ids, ['p2', 'p1', 'p3'], 'never focused first, most recently focused last');
});

test('any change in between drops the memory: moved, resized, restored by hand, opened, closed, other workspace', () => {
  const before = [P('p1'), P('p2')]; const min = before.map((p) => ({ ...p, minimized: true })); const memo = rememberMinimized(min, 'main', ['p1', 'p2']);
  const fresh = (list, ws = 'main') => planShowDesktop(list, ws, memo).action;
  assert.equal(fresh(min), 'restore');
  assert.equal(fresh([{ ...min[0], x: 50 }, min[1]]), 'none', 'moved while minimized: nothing visible, nothing to do');
  assert.equal(fresh([{ ...min[0], minimized: false }, min[1]]), 'minimize', 'one restored by hand: minimize what shows');
  assert.equal(fresh([...min, P('p3')]), 'minimize', 'a new window opened');
  assert.equal(fresh([min[0]]), 'none', 'a window was closed');
  assert.equal(fresh(min, 'other'), 'none', 'another workspace has its own memory');
});

test('formation ignores other workspaces and docked windows', () => {
  const a = formation([P('p1'), P('p2', { ws: 'x' }), P('p3', { placement: 'dock' })], 'main');
  assert.equal(a, formation([P('p1')], 'main'));
});
