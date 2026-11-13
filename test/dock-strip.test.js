import test from 'node:test';
import assert from 'node:assert/strict';
import { thumbGeometry, scrollForDrag, MIN_THUMB } from '../public/dock-strip.js';

test('no thumb when the content fits', () => {
  assert.equal(thumbGeometry({ track: 500, view: 500, total: 500, scroll: 0 }).visible, false);
  assert.equal(thumbGeometry({ track: 0, view: 500, total: 900, scroll: 0 }).visible, false);
});

test('thumb height is proportional and never below the minimum', () => {
  assert.equal(thumbGeometry({ track: 400, view: 400, total: 800, scroll: 0 }).height, 200);
  assert.equal(thumbGeometry({ track: 400, view: 400, total: 100000, scroll: 0 }).height, MIN_THUMB);
});

test('thumb sits at the top and bottom at the scroll extremes, and clamps overscroll', () => {
  const base = { track: 400, view: 400, total: 800 };
  assert.equal(thumbGeometry({ ...base, scroll: 0 }).top, 0);
  assert.equal(thumbGeometry({ ...base, scroll: 400 }).top, 200);
  assert.equal(thumbGeometry({ ...base, scroll: 9999 }).top, 200);
  assert.equal(thumbGeometry({ ...base, scroll: -5 }).top, 0);
});

test('dragging the thumb maps to scroll and clamps', () => {
  const a = { track: 400, thumb: 200, view: 400, total: 800 };
  assert.equal(scrollForDrag({ ...a, startScroll: 0, dy: 100 }), 200);
  assert.equal(scrollForDrag({ ...a, startScroll: 0, dy: 9999 }), 400);
  assert.equal(scrollForDrag({ ...a, startScroll: 100, dy: -9999 }), 0);
  assert.equal(scrollForDrag({ ...a, thumb: 400, startScroll: 0, dy: 10 }), 0);
});
