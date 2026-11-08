import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { integrateInstructions, installAgentInstructions } from '../src/agent.js';
import { tmp } from './helpers.js';

test('agent instructions preserve project content and update their own block idempotently', () => {
  const original = '# Project\n\nKeep these rules.\n';
  const first = integrateInstructions(original, 'First instructions');
  assert.ok(first.startsWith(original));
  assert.equal(integrateInstructions(first, 'First instructions'), first);
  const updated = integrateInstructions(first + '\n## More rules\nKeep these too.\n', 'Updated instructions');
  assert.ok(updated.startsWith(original)); assert.ok(updated.endsWith('\n## More rules\nKeep these too.\n'));
  assert.match(updated, /Updated instructions/); assert.doesNotMatch(updated, /First instructions/);
});

test('agent setup validates all files before writing and refuses symlinks or broken markers', () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Existing\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '<!-- hatch:begin -->\nbroken');
  assert.throws(() => installAgentInstructions({dir}), /markers/);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Existing\n');
  fs.rmSync(path.join(dir, 'AGENTS.md')); const elsewhere = path.join(tmp(), 'instructions'); fs.writeFileSync(elsewhere, 'untouched');
  fs.symlinkSync(elsewhere, path.join(dir, 'AGENTS.md'));
  assert.throws(() => installAgentInstructions({dir}), /regular file/);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'untouched');
  fs.rmSync(path.join(dir, 'AGENTS.md'));
  let results = installAgentInstructions({dir}); assert.ok(results.every((r) => r.changed));
  results = installAgentInstructions({dir}); assert.ok(results.every((r) => !r.changed));
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /Granular progress workflow/);
  assert.throws(() => installAgentInstructions({dir,target:'typo'}), /--target/);
});
