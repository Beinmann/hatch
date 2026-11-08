// Checks the things Hatch depends on and says how to fix each. Shared by `hatch-server doctor` and `hatch doctor`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findStateDir, makeClient } from './find.js';

const tool = (cmd, args = ['-V']) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.error ? null : (r.stdout || r.stderr).trim().split('\n')[0]; };

export async function doctor({ state } = {}) {
  const checks = [];
  const add = (name, ok, detail, fix, optional = false) => checks.push({ name, ok, detail, fix, optional });
  const major = Number(process.versions.node.split('.')[0]);
  add('node >= 20', major >= 20, process.version, 'install Node.js 20 or newer');
  const py = tool('python3'); add('python3', !!py, py || 'not found', 'install python3 (needed for the pty helper; standard library only)');
  const tm = tool('tmux', ['-V']); add('tmux', !!tm, tm || 'not found', 'install tmux (apt install tmux)');
  // optional tools: missing ones only switch a feature off, so they never fail the check
  const tver = /tmux (\d+)\.(\d+)/.exec(tm || ''); if (tver && (Number(tver[1]) < 3 || (Number(tver[1]) === 3 && Number(tver[2]) < 2))) add('tmux >= 3.2', false, tm, 'older tmux works but HATCH_URL/HATCH_STATE only reach new windows', true);
  const gt = tool('git', ['--version']); add('git (git window, hatch diff/log)', !!gt, gt || 'not found', 'install git to use the git window', true);
  const rg = tool('rg', ['--version']); add('ripgrep (faster hatch grep)', !!rg, rg || 'not found: grep -rn is used instead', 'optional: apt install ripgrep', true);
  const mn0 = tool('man', ['--version']); const mn = mn0 && /man-db|mandoc|\d+\.\d+/.test(mn0) ? mn0 : null; // minimal images ship a stub that only prints a notice
  add('man (hatch man)', !!mn, mn || 'not found or a stub', 'optional: apt install man-db', true);
  let dir = null;
  try { dir = findStateDir({ state }); add('state dir', true, dir); } catch (e) { add('state dir', false, e.message, 'run `hatch-server serve` once in your project'); }
  if (dir) {
    try { const f = path.join(dir, '.doctor'); fs.writeFileSync(f, 'x'); fs.rmSync(f); add('state dir writable', true, dir); } catch (e) { add('state dir writable', false, e.message, `fix permissions on ${dir}`); }
    try { const api = makeClient(dir); await api('GET', '/api/health'); add('server reachable', true, 'GET /api/health ok'); } catch (e) { add('server reachable', false, e.message, 'start it with `hatch-server serve`'); }
  }
  return checks;
}

export function printChecks(checks, out = console.log) {
  for (const c of checks) out(`${c.ok ? 'ok  ' : c.optional ? 'note' : 'FAIL'}  ${c.name}: ${c.detail}${c.ok ? '' : `\n      ${c.optional ? 'optional' : 'fix'}: ${c.fix}`}`);
  return checks.every((c) => c.ok || c.optional);
}
