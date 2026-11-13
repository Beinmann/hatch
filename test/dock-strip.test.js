import test from 'node:test';
import assert from 'node:assert/strict';
import { thumbGeometry, wheelPixels, MIN_THUMB } from '../public/dock-strip.js';

test('no indicator when the content fits', () => {
  assert.equal(thumbGeometry({ track: 500, view: 500, total: 500, scroll: 0 }).visible, false);
  assert.equal(thumbGeometry({ track: 0, view: 500, total: 900, scroll: 0 }).visible, false);
});

test('indicator height is proportional and never below the minimum', () => {
  assert.equal(thumbGeometry({ track: 400, view: 400, total: 800, scroll: 0 }).height, 200);
  assert.equal(thumbGeometry({ track: 400, view: 400, total: 100000, scroll: 0 }).height, MIN_THUMB);
});

test('indicator sits at the top and bottom at the scroll extremes, and clamps overscroll', () => {
  const base = { track: 400, view: 400, total: 800 };
  assert.equal(thumbGeometry({ ...base, scroll: 0 }).top, 0);
  assert.equal(thumbGeometry({ ...base, scroll: 400 }).top, 200);
  assert.equal(thumbGeometry({ ...base, scroll: 9999 }).top, 200);
  assert.equal(thumbGeometry({ ...base, scroll: -5 }).top, 0);
});

test('wheel delta is converted to pixels for pixel, line and page modes', () => {
  assert.equal(wheelPixels({ deltaMode: 0, deltaY: 40 }, 500), 40);
  assert.equal(wheelPixels({ deltaMode: 1, deltaY: 3 }, 500), 48);
  assert.equal(wheelPixels({ deltaMode: 2, deltaY: 1 }, 500), 500);
});
