// Test entry point (npm test): runs the whole suite with HOME in a temp dir and the HATCH_* variables of the
// developer's shell removed, so no test can read or write the real ~/.hatch or talk to a running instance.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-test-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
for (const k of Object.keys(env)) if (k.startsWith('HATCH_')) delete env[k];

const files = fs.readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.test.js')).sort()
  .map((f) => path.join('test', f));
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { env, stdio: 'inherit' });
child.on('close', (code, sig) => {
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(sig ? 1 : code);
});
