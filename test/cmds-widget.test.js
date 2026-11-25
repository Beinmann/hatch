import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../examples/widgets/cmds/', import.meta.url));
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'widget.json'), 'utf8'));
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

test('cmds widget: source prints the data file, or null when there is none', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-cmds-'));
  const src = meta.sources.find((s) => s.name === 'list');
  const cmd = src.cmd.replaceAll('{{state}}', state).replaceAll('{{widget}}', 'cmds');
  const run = () => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(run(), 'null');
  fs.mkdirSync(path.join(state, 'widgets/cmds/data'), { recursive: true });
  const list = { groups: [{ label: 'a', commands: ['ls'] }] };
  fs.writeFileSync(path.join(state, 'widgets/cmds/data/cmds.json'), JSON.stringify(list));
  assert.deepEqual(JSON.parse(run()), list);
});

test('cmds widget: the page script parses', () => {
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(js));
});
