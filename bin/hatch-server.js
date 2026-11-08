#!/usr/bin/env node
// hatch-server: serve | clear | start | stop | restart | status | url | doctor | service | agent (the page-driving commands are `hatch`)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { firstCommandIndex, withoutOption } from '../src/cli-options.js';
import { spawnSync } from 'node:child_process';
import { createHatch } from '../src/server.js';
import { doctor, printChecks } from '../src/doctor.js';
import { findStateDir, findServerStateDir, isValidStateDir, readConfig } from '../src/find.js';

const HELP = `hatch-server: run and administer the Hatch server. (To drive the page from the terminal use \`hatch\`.)

usage:
  hatch-server serve [--host H] [--port N] [--state DIR] [--session NAME] [--cwd DIR] [--root DIR] [--view-only] [--tmux-status] [--yes]
  hatch-server start|stop|restart|status [serve options]   run the server in the background (pid in <state>/hatch.pid, log in <state>/log/daemon.log)
  hatch-server agent init [--target claude|codex|both]     add persistent project instructions (same as hatch agent init)
  hatch-server clear [--state DIR] [--yes]   delete everything in the state dir (widgets, notes, trash, token) to recover from a bad state; asks first, refuses while a server uses it
  hatch-server url [--state DIR]       print the URL with the token again
  hatch-server url --view              print a watch-only URL (makes a separate view token the first time); --revoke-view removes it
  hatch-server doctor [--state DIR]    check node, python3, tmux, state dir, server
  hatch-server service [--state DIR] [--port N] [--host H]   print a systemd user unit that starts hatch-server serve (nothing is installed)
  hatch-server --help | --version

serve defaults: host 0.0.0.0 (reachable from your LAN), port 7070, state ./.hatch of the current directory (parent directories are not searched), session derived from the project.
If the state dir has no valid config.json, serve|start|restart ask before creating it; --yes creates it without asking. Without a terminal to ask on they fail unless --yes is given, so
background and service setups should pass --yes or an existing --state DIR.
Put .hatch/ in your .gitignore. The token is a convenience, not security: use only on isolated networks.`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o._.push(...argv.slice(i + 1)); break; }
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--version') o.version = true;
    else if (a === '--view-only') o['view-only'] = 'true';
    else if (a === '--tmux-status') o['tmux-status'] = 'true';
    else if (a === '--yes') o.yes = 'true';
    else if (a === '--view' || a === '--revoke-view') o[a.slice(2)] = 'true';
    else if (a.startsWith('--')) { const [k, v] = a.slice(2).split(/=(.*)/s); o[k] = v ?? argv[++i]; if (o[k] === undefined) fail(`--${k} needs a value`); }
    else o._.push(a);
  }
  return o;
}
function fail(m, code = 1) { console.error(`hatch-server: ${m}`); process.exit(code); }

// Creating a state dir is a decision: ask (naming the full path) unless --yes; never hang or create silently without a terminal.
async function confirmStateDir(dir) {
  if (isValidStateDir(dir) || o.yes === 'true') return;
  const how = `Pass --yes to create it without asking, or --state DIR to use an existing Hatch state dir.`;
  if (!process.stdin.isTTY || !process.stderr.isTTY) fail(`no valid Hatch state dir at ${dir} (no usable config.json) and no terminal to ask on. ${how}`);
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`No Hatch state dir at ${dir}. Create it? [y/N] `)).trim().toLowerCase(); rl.close();
  if (answer !== 'y' && answer !== 'yes') fail(`not creating ${dir}. ${how}`);
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

// `agent` lives in `hatch` (it needs no server); forward without reparsing its flags. Global options can precede the command.
const argv = process.argv.slice(2); const commandPosition = firstCommandIndex(argv);
if (argv[commandPosition] === 'agent') {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./hatch.js', import.meta.url)), ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const o = parse(process.argv.slice(2));
const cmd = o._[0];
if (o.version) { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version); process.exit(0); }
if (o.help || !cmd) { console.log(HELP); process.exit(cmd || o.help ? 0 : 1); }

if (['start', 'stop', 'restart', 'status'].includes(cmd)) {
  const d = await import('../src/daemon.js');
  const state = findServerStateDir({ state: o.state });
  if ((cmd === 'start' || cmd === 'restart') && !d.runningPid(state)) await confirmStateDir(state);
  const rest = withoutOption(withoutOption(argv.filter((_, i) => i !== commandPosition), 'state'), 'yes');
  try {
    if (cmd === 'status') { const pid = d.runningPid(state); console.log(pid ? `running (pid ${pid}); URL: hatch-server url` : 'not running'); process.exit(pid ? 0 : 1); }
    if (cmd === 'stop') console.log((await d.stop(state)) ? 'stopped' : 'was not running');
    else {
      const r = await (cmd === 'restart' ? d.restart : d.start)(state, path.resolve(process.argv[1]), rest);
      console.log(r.already ? `already running (pid ${r.pid}); use \`hatch-server restart\` to reload code` : r.log.trim());
    }
  } catch (e) { fail(e.message); }
  process.exit(0);
}
if (cmd === 'clear') {
  const dir = path.resolve(o.state || process.env.HATCH_STATE || '.hatch');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no state dir at ${dir}; nothing to clear. Pass --state DIR to choose another.`);
  const d = await import('../src/daemon.js');
  const stop = `Stop it first (\`hatch-server stop --state ${dir}\` or Ctrl+C in its terminal), then run clear again.`;
  const pid = d.runningPid(dir);
  if (pid) fail(`a Hatch server (pid ${pid}) is running on ${dir}. ${stop}`);
  if (isValidStateDir(dir)) { // a foreground server has no pid file: ask the port from config.json
    const { makeClient } = await import('../src/find.js');
    const up = await makeClient(dir)('GET', '/api/health').then(() => true, (e) => e.code !== 2 && !/cannot reach/.test(e.message));
    if (up) fail(`a Hatch server is answering on the port in ${path.join(dir, 'config.json')}. ${stop}`);
  }
  const names = fs.readdirSync(dir);
  if (!names.length) { console.log(`${dir} is already empty`); process.exit(0); }
  if (o.yes !== 'true') {
    if (!process.stdin.isTTY || !process.stderr.isTTY) fail(`no terminal to ask on. Pass --yes to delete everything in ${dir}.`);
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`Delete ALL ${names.length} entries in ${dir} (widgets, notes, trash, token)? [y/N] `)).trim().toLowerCase(); rl.close();
    if (answer !== 'y' && answer !== 'yes') fail(`nothing removed from ${dir}.`);
  }
  for (const n of names) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  console.log(`removed ${names.length} entries from ${dir}: ${names.join(', ')}\nThe next \`hatch-server serve\` creates a fresh state (with a new token and URL).`);
  process.exit(0);
}
if (cmd === 'doctor') { process.exit(printChecks(await doctor({ state: o.state })) ? 0 : 1); }
if (cmd === 'url') {
  const dir = findStateDir({ state: o.state }); const c = readConfig(dir); const file = path.join(dir, 'config.json');
  const save = (cfg) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(tmp, file); }; // temp + rename: a running server never reads half a file
  if (process.argv.includes('--revoke-view')) { delete c.viewToken; save(c); console.log('view token removed: existing watch-only links stop working'); process.exit(0); }
  if (process.argv.includes('--view')) {
    if (!c.viewToken) { c.viewToken = (await import('node:crypto')).randomBytes(16).toString('hex'); save(c); }
    console.log(`http://${lanAddress()}:${c.port}/?t=${c.viewToken}`); console.log('Watch-only: this link can see the terminal and windows but cannot type, run, or read files.'); process.exit(0);
  }
  console.log(`http://${lanAddress()}:${c.port}/?t=${c.token}`); process.exit(0);
}
if (cmd === 'service') {
  const exe = path.resolve(process.argv[1]); const state = findServerStateDir({ state: o.state }); const wd = path.dirname(state);
  // systemd: % and $ are special even inside quotes (written %% and $$); quotes and backslashes are escaped with a backslash
  const q = (x) => { const e = x.replace(/%/g, '%%').replace(/\$/g, '$$$$'); return /^[\w@+=:,./%$-]+$/.test(e) ? e : `"${e.replace(/(["\\])/g, '\\$1')}"`; };
  const args = ['serve', '--state', state, ...(o.port ? ['--port', String(o.port)] : []), ...(o.host ? ['--host', o.host] : [])];
  console.log(`# ~/.config/systemd/user/hatch.service
[Unit]
Description=Hatch: browser terminal and panels
After=network.target

[Service]
WorkingDirectory=${q(wd)}
ExecStart=${q(process.execPath)} ${q(exe)} ${args.map(q).join(' ')}
Environment=PATH=${process.env.PATH}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
#
# Install:  save the lines above as ~/.config/systemd/user/hatch.service, then
#   systemctl --user daemon-reload && systemctl --user enable --now hatch
#   loginctl enable-linger $USER      # keep it running when you are logged out
# The tmux session survives restarts of the service; the URL with the token is in ${path.join(state, 'config.json')}
# (or: hatch-server url --state ${q(state)}).`);
  process.exit(0);
}
if (cmd !== 'serve') fail(`unknown command ${cmd}. Try \`hatch-server --help\`.`);

const host = o.host || '0.0.0.0';
const port = o.port === undefined ? 7070 : Number(o.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a number between 0 and 65535');
const stateDir = findServerStateDir({ state: o.state });
await confirmStateDir(stateDir);
let hatch;
try { hatch = createHatch({ tmuxStatus: o['tmux-status'] === 'true', viewOnly: o['view-only'] === 'true' || process.argv.includes('--view-only'), root: o.root, stateDir, host, port, session: o.session, cwd: path.resolve(o.cwd || process.cwd()) }); }
catch (e) { fail(['EACCES', 'EROFS', 'EPERM', 'ENOENT'].includes(e.code) ? `cannot create the state dir ${stateDir} (${e.code}). Run hatch-server in a writable directory or pass --state DIR.` : e.message); }
try { await hatch.listen(); } catch (e) {
  fail(e.code === 'EADDRINUSE' ? `port ${port} is in use. Pick another with --port N (is hatch-server already running?)` : e.message);
}
const actual = hatch.server.address().port;
const shown = host === '0.0.0.0' || host === '::' ? lanAddress() : host;
console.log(`Hatch ${hatch.config.session ? '' : ''}is running (tmux session "${hatch.session}", state ${stateDir})`);
console.log(`\n  http://${shown}:${actual}/?t=${hatch.token}\n`);
console.log(host === '0.0.0.0' || host === '::'
  ? `Listening on all interfaces: anyone on this network with the URL can run commands on this box. Use --host 127.0.0.1 to limit it.`
  : `Listening on ${host} only.`);
if (hatch.viewOnly) console.log('VIEW-ONLY: this page mirrors the terminal and panels; it cannot type, run, read files or change anything.');
if (o.root) console.log(`File access (browser, editor, downloads, uploads) is confined to ${path.resolve(o.root)}. Terminal, run and widget commands are NOT confined.`);
console.log('Inside tmux, Claude can drive the page with `hatch` (see README). Ctrl+C stops the server; the tmux session keeps running.');
const stop = async () => { await hatch.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
