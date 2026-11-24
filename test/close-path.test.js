import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createState } from '../src/state.js';
import { closePanel, isGone, safely } from '../public/close-path.js';
import { tmp } from './helpers.js';

test('closePanel: a vanished panel still removes the window; other errors do not', async () => {
  const removed = []; const errors = [];
  const run = (err) => closePanel('p1', { del: async () => { if (err) throw err; }, remove: (i) => removed.push(i), onError: (e) => errors.push(e.message) });
  assert.equal(await run(null), true); assert.deepEqual(removed, [], 'success leaves removal to the server event');
  assert.equal(await run(new Error('no panel p1')), true); assert.deepEqual(removed, ['p1']);
  assert.equal(await run(new Error('boom')), false); assert.deepEqual(errors, ['boom']); assert.equal(removed.length, 1);
  assert.ok(isGone(Object.assign(new Error('x'), { status: 404 })));
});

test('safely: one failing step does not stop the next', () => {
  const seen = []; safely(() => { throw new Error('a'); }, (e) => seen.push(e.message)); assert.deepEqual(seen, ['a']);
  assert.equal(safely(() => 5), 5);
});

test('a patch after delete is a 404 and does not bring the panel back', () => {
  const dir = tmp(); const st = createState(dir, { emit() {}, poll: true }); st.start();
  const p = st.createPanel({ type: 'note', props: { markdown: 'x' } });
  st.deletePanel(p.id);
  assert.throws(() => st.patchPanel(p.id, { props: { hidden: true } }), /no panel/);
  assert.throws(() => st.deletePanel(p.id), /no panel/);
  assert.equal(st.listPanels().length, 0); st.close();
});

// A comment line swallowed the rest of an object literal once (widget views lost destroy() and windows could not close).
test('every panel view defines destroy() outside a // comment', () => {
  const dir = new URL('../public/panels/', import.meta.url).pathname;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/destroy/.test(src)) continue;
    for (const line of src.split('\n')) {
      const i = line.search(/\/\/ /);
      if (i >= 0 && /\b(destroy|update)\(\)/.test(line.slice(i)) && !/^\s*\/\//.test(line)) assert.fail(`${f}: destroy/update hidden in a trailing comment: ${line.trim().slice(0, 80)}`);
    }
    assert.match(src, /destroy\s*[(:]/, `${f} must define destroy`);
  }
});
