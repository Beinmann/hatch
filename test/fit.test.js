import test from 'node:test';
import assert from 'node:assert/strict';
import { fitFloat } from '../public/fit.js';

const area = { width: 800, height: 600 };

test('a window already inside is left alone', () => {
  assert.deepEqual(fitFloat({ x: 40, y: 40, w: 300, h: 200 }, area), { x: 40, y: 40, w: 300, h: 200 });
});

test('a window crossing the right or bottom edge is moved in, not resized', () => {
  assert.deepEqual(fitFloat({ x: 700, y: 500, w: 300, h: 200 }, area), { x: 500, y: 400, w: 300, h: 200 });
});

test('negative positions are clamped to the origin', () => {
  assert.deepEqual(fitFloat({ x: -50, y: -5, w: 300, h: 200 }, area), { x: 0, y: 0, w: 300, h: 200 });
});

test('a window larger than the area is shrunk to it', () => {
  assert.deepEqual(fitFloat({ x: 100, y: 100, w: 1000, h: 900 }, area), { x: 0, y: 0, w: 800, h: 600 });
});

test('the input is not modified, so a bigger area restores the original place', () => {
  const g = { x: 700, y: 40, w: 300, h: 200 };
  fitFloat(g, { width: 400, height: 600 });
  assert.deepEqual(fitFloat(g, area), { x: 500, y: 40, w: 300, h: 200 });
});

test('minimum size wins over a tiny area but never exceeds the area', () => {
  assert.equal(fitFloat({ x: 0, y: 0, w: 50, h: 50 }, area).w, 180);
  assert.equal(fitFloat({ x: 0, y: 0, w: 500, h: 500 }, { width: 100, height: 50 }).w, 100);
});
