import test from 'node:test';
import assert from 'node:assert/strict';
import { calc, formatResult } from '../public/calc.js';

test('calculator: precedence, parentheses, powers, functions, constants, decimals', () => {
  assert.equal(calc('2+3*4'), 14); assert.equal(calc('(2+3)*4'), 20); assert.equal(calc('2^3^2'), 512, 'power is right associative'); assert.equal(calc('-2^2'), -4);
  assert.equal(calc('10/4'), 2.5); assert.equal(calc('10%4'), 2); assert.equal(calc('sqrt(16)+abs(-3)'), 7); assert.equal(calc('max(1;5;3)'), 5); assert.equal(calc('1,5*2'), 3, 'comma decimals');
  assert.ok(Math.abs(calc('sin(pi/2)') - 1) < 1e-12); assert.equal(calc('2 * ( 3 + 4 )'), 14); assert.equal(calc('1e3+1'), 1001); assert.equal(calc('--3'), 3);
  assert.equal(formatResult(0.1 + 0.2), '0.3'); assert.equal(formatResult(1 / 3), '0.333333333333'); assert.equal(formatResult(1024), '1024');
});

test('calculator: errors are messages, and nothing but arithmetic is accepted', () => {
  for (const bad of ['', '2+', '(1', '1)', 'foo', 'sqrt', 'alert(1)', 'process.exit()', '1/0', '2**3', '1+a', '$HOME']) assert.throws(() => calc(bad), (e) => e instanceof Error && e.message.length > 0, bad);
  assert.throws(() => calc('('.repeat(5000) + '1' + ')'.repeat(5000)), /too long/); assert.throws(() => calc('9^9^9^9'), /finite/);
  assert.throws(() => calc('constructor'), /unknown/); assert.throws(() => calc('toString()'), /unknown|needs|unexpected/);
});
