import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A const used before its line in public/windows.js once stopped app.js halfway: the page loaded but no terminal appeared.
// No test of server routes can see that, so run the page script against DOM stubs and require that it gets to the end.
test('public/app.js runs its top level without throwing', () => {
  const fixture = fileURLToPath(new URL('./fixtures/stub-page.mjs', import.meta.url));
  const app = fileURLToPath(new URL('../public/app.js', import.meta.url));
  const r = spawnSync(process.execPath, [fixture, app], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } });
  assert.match(r.stdout, /ran to the end/, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /TOP-LEVEL ERROR|UNHANDLED REJECTION/, r.stdout);
});
