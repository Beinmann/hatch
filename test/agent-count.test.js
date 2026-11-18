import test from 'node:test';
import assert from 'node:assert/strict';
import { countAgents, agentChipView } from '../public/agent-count.js';

const plan = (...statuses) => ({ steps: statuses.map((status, i) => ({ id: `s${i}`, status })) });

test('a plan with a running step is one running agent; blocked only counts when nothing runs', () => {
  assert.deepEqual(countAgents([]), { running: 0, blocked: 0 });
  assert.deepEqual(countAgents([plan('done', 'running', 'todo'), plan('running', 'blocked'), plan('blocked', 'todo'), plan('done'), plan()]), { running: 2, blocked: 1 });
});

test('malformed plans count as nothing', () => {
  assert.deepEqual(countAgents([null, {}, { steps: 'x' }, { steps: [null] }]), { running: 0, blocked: 0 });
});

test('chip text, state and label', () => {
  assert.deepEqual(agentChipView({ running: 0, blocked: 0 }), { text: '0 running', state: 'idle', label: 'No agents running; click to open progress' });
  assert.equal(agentChipView({ running: 2, blocked: 0 }).text, '2 running');
  assert.equal(agentChipView({ running: 2, blocked: 0 }).state, 'ok');
  const b = agentChipView({ running: 1, blocked: 1 });
  assert.equal(b.state, 'warn'); assert.equal(b.text, '1 running, 1 blocked'); assert.match(b.label, /1 agent running, 1 agent blocked/);
});
