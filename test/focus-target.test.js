import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTarget, focusWindowContent, wantsRetry, FOCUSABLE } from '../public/focus-target.js';

// Minimal fake DOM: an element knows its parent, and focus() moves doc.activeElement only when `canFocus`.
function fake(doc, { tabindex = null, canFocus = true, matches = false, kids = [] } = {}) {
  const n = { parent: null, kids, canFocus,
    getAttribute: (k) => (k === 'tabindex' ? tabindex : null), matches: () => matches, querySelector: () => kids[0] || null,
    focus() { if (n.canFocus) doc.activeElement = n; },
    contains(o) { for (let x = o; x; x = x.parent) if (x === n) return true; return false; } };
  kids.forEach((k) => { k.parent = n; });
  return n;
}

test('contentTarget: root with tabindex 0 wins, tabindex -1 root falls back to a focusable child, none gives null', () => {
  const doc = {};
  const child = fake(doc);
  assert.equal(contentTarget(fake(doc, { tabindex: '0', matches: true, kids: [child] })).getAttribute('tabindex'), '0');
  assert.equal(contentTarget(fake(doc, { tabindex: '-1', matches: true, kids: [child] })), child);
  assert.equal(contentTarget(fake(doc)), null);
  assert.equal(contentTarget(null), null);
  assert.match(FOCUSABLE, /iframe/);
});

test('view.focus() puts focus inside the window: done', () => {
  const doc = { activeElement: null };
  const root = fake(doc, { tabindex: '0' }); const node = fake(doc, { kids: [root] });
  const w = { node, view: { el: root, focus() { root.focus(); } } };
  assert.equal(focusWindowContent(w, doc), true); assert.equal(doc.activeElement, root);
});

test('a panel without focus() (iframe or page window) gets its focusable content focused, not just the frame', () => {
  const doc = { activeElement: null };
  const frame = fake(doc); const root = fake(doc, { kids: [frame] }); const node = fake(doc, { kids: [root] });
  const w = { node, view: { el: root } };
  assert.equal(focusWindowContent(w, doc), true); assert.equal(doc.activeElement, frame);
});

test('a view.focus() that did nothing is retried on the content, the frame alone does not count', () => {
  const doc = { activeElement: null };
  const input = fake(doc); const root = fake(doc, { kids: [input] }); const node = fake(doc, { kids: [root] });
  const w = { node, view: { el: root, focus() { /* not ready: does nothing */ } } };
  assert.equal(focusWindowContent(w, doc), true); // fallback to the first focusable child
  assert.equal(doc.activeElement, input);
});

test('reports false when nothing inside can take focus (e.g. hidden), so the caller retries', () => {
  const doc = { activeElement: null };
  const root = fake(doc, { tabindex: '0', canFocus: false }); const node = fake(doc, { canFocus: false, kids: [root] });
  assert.equal(focusWindowContent({ node, view: { el: root, focus() { root.focus(); } } }, doc), false);
});

test('a view that throws does not break focusing', () => {
  const doc = { activeElement: null };
  const root = fake(doc, { tabindex: '0', matches: true }); const node = fake(doc, { kids: [root] });
  assert.equal(focusWindowContent({ node, view: { el: root, focus() { throw new Error('not ready'); } } }, doc), true);
});

test('wantsRetry: only while still the focused window and the keyboard sits on the body, nowhere or the frame', () => {
  const body = {}; const node = {}; const other = {};
  assert.equal(wantsRetry({ stillFocused: true, active: body, body, node }), true);
  assert.equal(wantsRetry({ stillFocused: true, active: null, body, node }), true);
  assert.equal(wantsRetry({ stillFocused: true, active: node, body, node }), true);
  assert.equal(wantsRetry({ stillFocused: true, active: other, body, node }), false); // someone took it on purpose (terminal, prompt)
  assert.equal(wantsRetry({ stillFocused: false, active: body, body, node }), false);
});
