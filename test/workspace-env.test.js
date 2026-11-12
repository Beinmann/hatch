import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHatch, tmp } from './helpers.js';

// A tmux stand-in that only records its arguments: has-session fails (no session yet), everything else succeeds.
const fakeTmux = (dir) => {
  const log = path.join(dir, 'tmux.log'); const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\n[ "$1" = has-session ] && exit 1\nexit 0\n`, { mode: 0o755 });
  return { bin, lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
};

test('terminals get HATCH_WORKSPACE of their workspace and start in its cwd', async () => {
  const scratch = tmp(); const t = fakeTmux(scratch); const projectDir = path.join(scratch, 'proj'); fs.mkdirSync(projectDir);
  const h = await startHatch({ attach: null, tmuxBin: t.bin });
  try {
    const w = (await h.call('POST', '/api/workspaces', { name: 'proj' })).data;
    // the registry may carry a cwd for the workspace (hatch migrate writes it)
    const reg = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'workspaces.json'), 'utf8'));
    reg.workspaces.find((x) => x.name === 'proj').cwd = projectDir; fs.writeFileSync(path.join(h.stateDir, 'workspaces.json'), JSON.stringify(reg));
    await new Promise((r) => setTimeout(r, 1500)); // the registry is re-read by the state watcher
    await h.call('POST', `/api/pterm/ws-${w.id}`, {});
    assert.ok(t.lines().some((l) => l.startsWith('new-session') && l.includes('-e HATCH_WORKSPACE=proj') && l.includes(`-c ${projectDir}`)), t.lines().join('\n'));
    // a terminal window follows its own window's workspace, and its own props.cwd wins
    const own = path.join(scratch, 'own'); fs.mkdirSync(own);
    await h.call('POST', '/api/panels', { type: 'terminal', props: { name: 'tw', cwd: own }, ws: 'proj' });
    await h.call('POST', '/api/pterm/tw', {});
    assert.ok(t.lines().some((l) => l.startsWith('new-session') && l.includes('-s hatch') && l.includes('tw') && l.includes('HATCH_WORKSPACE=proj') && l.includes(`-c ${own}`)), t.lines().join('\n'));
    // moved to another workspace: the next ensure refreshes the variable for new tmux windows
    await h.call('POST', '/api/workspaces', { name: 'other' });
    const p = (await h.call('GET', '/api/panels')).data.find((x) => x.props?.name === 'tw');
    await h.call('PATCH', `/api/panels/${p.id}`, { ws: 'other' });
    await h.call('POST', '/api/pterm/tw', {});
    assert.ok(t.lines().some((l) => /^set-environment .* HATCH_WORKSPACE other$/.test(l)), t.lines().join('\n'));
  } finally { await h.close(); }
});
