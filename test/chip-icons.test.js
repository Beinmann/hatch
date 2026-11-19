import test from 'node:test';
import assert from 'node:assert/strict';
import { iconKey } from '../public/chip-icons.js';

test('iconKey: widget panels pick an icon by widget name, other types keep their type', () => {
  const w = (name) => ({ type: 'widget', props: { name } });
  assert.equal(iconKey(w('git')), 'git');
  assert.equal(iconKey(w('git-myproject')), 'git');
  assert.equal(iconKey(w('Git')), 'git');
  assert.equal(iconKey(w('ports')), 'network');
  assert.equal(iconKey(w('clock')), 'clock');
  assert.equal(iconKey(w('gitlab-stats')), 'widget', 'only git or git-<x>, not any name starting with git');
  assert.equal(iconKey(w('something-else')), 'widget');
  assert.equal(iconKey({ type: 'widget' }), 'widget');
  assert.equal(iconKey({ type: 'git' }), 'git');
  assert.equal(iconKey({ type: 'note', props: { name: 'git' } }), 'note');
});
