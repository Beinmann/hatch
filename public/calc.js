// A tiny calculator for the palette ("=2*(3+4)"): a recursive descent parser over numbers, + - * / % ^, parentheses,
// a few functions and constants. No eval and no access to anything else.
const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp, round: Math.round, floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max };
const CONSTS = { pi: Math.PI, e: Math.E };

export function calc(input) {
  const src = String(input).replace(/,/g, '.').replace(/\s+/g, ''); let i = 0;
  if (!src) throw new Error('empty');
  if (src.length > 200) throw new Error('expression too long'); // also bounds the parser's recursion depth
  const peek = () => src[i];
  function number() {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i)); if (!m) return null; i += m[0].length; return Number(m[0]);
  }
  function primary() {
    if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') throw new Error('missing )'); i++; return v; }
    if (peek() === '-') { i++; return -power(); }
    if (peek() === '+') { i++; return power(); }
    const n = number(); if (n !== null) return n;
    const w = /^[a-z]+/i.exec(src.slice(i)); if (!w) throw new Error(`unexpected "${peek() ?? 'end'}"`);
    const name = w[0].toLowerCase(); i += name.length;
    if (Object.hasOwn(CONSTS, name)) return CONSTS[name];
    if (Object.hasOwn(FUNCS, name)) { if (peek() !== '(') throw new Error(`${name} needs ( )`); i++; const args = [expr()]; while (peek() === ';') { i++; args.push(expr()); } if (peek() !== ')') throw new Error('missing )'); i++; return FUNCS[name](...args); }
    throw new Error(`unknown name ${name}`);
  }
  function power() { const base = primary(); if (peek() === '^') { i++; return base ** power(); } return base; } // right associative
  function term() { let v = power(); while (peek() === '*' || peek() === '/' || peek() === '%') { const op = src[i++]; const r = power(); v = op === '*' ? v * r : op === '/' ? v / r : v % r; } return v; }
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  const v = expr(); if (i < src.length) throw new Error(`unexpected "${src[i]}"`);
  if (!Number.isFinite(v)) throw new Error('not a finite number');
  return v;
}

export const formatResult = (v) => (Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : String(Number(v.toPrecision(12))));
