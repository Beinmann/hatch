import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { outputReferences } from '../public/panels/output.js';

test('output references retain full absolute and relative paths, line numbers and columns', () => {
  const text = 'error: src/app.js:12:3; /tmp/project/file.test.js:8 and ../other/file.ts:21\nfile.md:2';
  assert.deepEqual([...outputReferences(text)].map((match) => [match[1], Number(match[2]), match[0]]), [
    ['src/app.js', 12, 'src/app.js:12:3'], ['/tmp/project/file.test.js', 8, '/tmp/project/file.test.js:8'],
    ['../other/file.ts', 21, '../other/file.ts:21'], ['file.md', 2, 'file.md:2'],
  ]);
});

test('a full retained line without references completes instead of freezing path detection', () => {
  // Run separately so a regression in the regex can be killed even if it blocks its JavaScript thread.
  const script = `import { outputReferences } from ${JSON.stringify(new URL('../public/panels/output.js', import.meta.url).href)};
    const matches = [...outputReferences('x'.repeat(512 * 1024))];
    if (matches.length) process.exit(1); console.log('complete');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'complete');
});
