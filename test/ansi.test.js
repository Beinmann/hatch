import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stripAnsi } from '../public/ansi.js';
import { stripAnsi as stripWatchAnsi } from '../src/watches.js';
import { startHatch, waitFor } from './helpers.js';

test('shared escape stripping handles CSI, OSC terminators, long titles, hyperlinks and charset changes', () => {
  const sample = '\x1b[38:2:255:0:0mred\x1b[0m ' +
    '\x1b]0;title\x07bell \x1b]0;' + 'long'.repeat(1000) + '\x1b\\st ' +
    '\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\ ' +
    '\x1b(B\x1b)0\x1b=\x1b>plain\r\n';
  assert.equal(stripAnsi(sample), 'red bell st link plain\r\n');
  assert.equal(stripWatchAnsi(sample), 'red bell st link plain\n');
  assert.equal(stripAnsi('a\x00\b\x07\x7fb\tc\r\nd'), 'ab\tc\r\nd');
  assert.equal(stripAnsi('text \x1b]unfinished'), 'text ]unfinished');
});

test('repeated malformed OSC prefixes do not cause quadratic scans', () => {
  const script = `import { stripAnsi } from ${JSON.stringify(new URL('../public/ansi.js', import.meta.url).href)};
    const text = '\\x1b]x'.repeat(170000); if (stripAnsi(text) !== ']x'.repeat(170000)) process.exit(1); console.log('complete');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'complete');
});

test('retained run output uses the same long OSC and ST cleanup as the browser', async () => {
  const h = await startHatch();
  try {
    const sample = '\x1b]0;' + 'title'.repeat(200) + '\x1b\\' + '\x1b[31mvisible\x1b[0m\n';
    const quoted = `'${sample.replaceAll("'", "'\\''")}'`;
    const run = (await h.call('POST', '/api/runs', { cmd: `printf '%s' ${quoted}` })).data;
    await waitFor(async () => (await h.call('GET', `/api/runs/${run.id}`)).data.state === 'done');
    assert.equal((await h.call('GET', `/api/runs/${run.id}/output`)).data, 'visible\n');
    assert.equal((await h.call('GET', '/ansi.js')).status, 200);
  } finally { await h.close(); }
});

test('streaming escape cleanup survives every split point without retaining hidden OSC payloads', async () => {
  const { createAnsiStripper } = await import('../public/ansi.js');
  const sample = 'before\x1b[31mred\x1b[0m\x1b]0;hidden title\x07\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\\x1b(B\x1b>after';
  const expected = stripAnsi(sample);
  for (let split = 0; split <= sample.length; split++) {
    const cleaner = createAnsiStripper();
    assert.equal(cleaner.push(sample.slice(0, split)) + cleaner.push(sample.slice(split)), expected, `split ${split}`);
  }
  const cleaner = createAnsiStripper();
  assert.equal([...sample].map(c => cleaner.push(c)).join(''), expected);
  assert.equal(cleaner.push('\x1b]0;' + 'hidden'.repeat(100000)), '');
  assert.equal(cleaner.push('\x1b\\visible'), 'visible');
});
