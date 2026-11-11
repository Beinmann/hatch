// Safety net for config.json: `hatch` finds the server through the port in <state>/config.json. If something else rewrites that file
// with another port (the case server.lock now prevents), the CLI points at a dead port. This watchdog polls the file and repairs
// ONLY `port` and `host` by read-modify-write, so hand edits (allowedHosts, viewToken, ...) survive. It acts only while server.lock
// names this process, backs off when repairs keep repeating (another writer is fighting us), and never invents a token: a missing
// or unparseable config.json is logged once and left alone (the server's startup repair owns that case).
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './state.js';
import { readLock, liveOwner } from './instance-guard.js';

/** `current()` returns { port, host } this server listens on now (it changes after a re-listen). Interval and clock are injectable. */
export function createConfigGuard({ stateDir, current, log = () => {}, intervalMs = 5000, minGapMs = 5000, maxRepairs = 5, windowMs = 60000, now = Date.now }) {
  const file = path.join(stateDir, 'config.json');
  let timer = null; let lastRepair = -Infinity; let repairs = []; // repair timestamps inside the window
  const said = new Set(); // one-time messages, cleared when the condition goes away so a later episode is logged again
  const once = (key, msg) => { if (!said.has(key)) { said.add(key); log(msg); } };
  const clear = (key) => said.delete(key);

  function check() {
    const lock = readLock(stateDir);
    if (!lock || lock.pid !== process.pid) {
      const other = liveOwner(stateDir);
      if (other) once('owner', `config guard idle: another Hatch server (pid ${other.pid}) owns ${stateDir}; not touching config.json`);
      return;
    }
    clear('owner');
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not an object'); }
    catch { once('unreadable', `config guard: ${file} is missing or not valid JSON; leaving it alone (restart Hatch to rebuild it)`); return; }
    clear('unreadable');
    const want = current();
    if (cfg.port === want.port && cfg.host === want.host) { clear('runaway'); return; }
    const t = now();
    repairs = repairs.filter((x) => t - x < windowMs);
    if (repairs.length >= maxRepairs) { once('runaway', `config guard: config.json changed ${maxRepairs} times within ${Math.round(windowMs / 1000)}s; another process keeps rewriting it, so repairs are paused (check what else runs on ${stateDir})`); return; }
    if (t - lastRepair < minGapMs) return;
    try {
      atomicWrite(file, `${JSON.stringify({ ...cfg, port: want.port, host: want.host }, null, 2)}\n`, { mode: 0o600 });
    } catch (e) { once('write', `config guard: cannot repair ${file}: ${e.message}`); return; }
    clear('write'); lastRepair = t; repairs.push(t);
    log(`WARNING config guard: config.json had port ${cfg.port} host ${cfg.host}, this server listens on ${want.host}:${want.port}; restored port and host only`);
  }

  return {
    check,
    start() { if (timer) return; timer = setInterval(() => { try { check(); } catch (e) { log(`config guard error: ${e.message}`); } }, intervalMs); timer.unref(); },
    stop() { clearInterval(timer); timer = null; },
    get running() { return timer !== null; },
  };
}
