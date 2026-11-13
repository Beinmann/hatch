// The browser terminal must count emoji and CJK as two columns (Unicode 11 widths), like tmux does; xterm's default tables count most emoji as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Unicode11Addon } from '../public/addon-unicode11.mjs';
import { emojiWidthProvider } from '../public/emoji-width.js';

function provider() {
  let p = null;
  new Unicode11Addon().activate({ unicode: { register: (x) => { p = x; } } });
  return p;
}

test('the Unicode 11 provider gives emoji and CJK two columns and ASCII one', () => {
  const p = provider();
  assert.equal(p.version, '11');
  for (const ch of ['😀', '👍', '🎉', '🚀', '✅', '漢']) assert.equal(p.wcwidth(ch.codePointAt(0)), 2, ch);
  assert.equal(p.wcwidth('a'.codePointAt(0)), 1);
});

test('terminal.js loads the addon and activates Unicode 11 with emoji fonts in the stack', () => {
  const src = readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
  assert.match(src, /new Unicode11Addon\(\)/);
  assert.match(src, /emojiWidthProvider\(widths\)/);
  assert.match(src, /unicode\.activeVersion = '11-emoji'/);
  assert.match(src, /allowProposedApi: true/);
  assert.match(src, /Noto Color Emoji/);
});

// Mirrors how xterm applies a provider: a joining character widens or keeps the previous cell, otherwise it starts a new one.
function columns(str) {
  const p = emojiWidthProvider(provider());
  let prev = 0, total = 0, last = 0;
  for (const ch of str) {
    const props = p.charProperties(ch.codePointAt(0), prev);
    const w = (props >> 1) & 3;
    if ((props & 1) && last > 0) { if (w > last) { total += w - last; last = w; } } else { total += w; last = w; }
    prev = props;
  }
  return total;
}

test('emoji clusters take two columns, like tmux', () => {
  for (const e of ['😀', '❤️', '⚠️', '👍🏽', '🇩🇪', '👨‍👩‍👧', '1️⃣', '漢']) assert.equal(columns(e), 2, e);
  assert.equal(columns('a😀b'), 4);
  assert.equal(columns('g❤️h'), 4);
  assert.equal(columns('é'), 1);
  assert.equal(columns('🇩🇪🇫🇷'), 4);
});
