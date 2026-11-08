// Things Hatch can find on the box so the palette can offer them: runnable tasks (package.json scripts, Makefile
// targets) and listening TCP ports (read from /proc, with the owning process name when it can be found).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Files of a project for the quick finder: `git ls-files` (tracked and untracked, minus ignored) or a bounded directory walk. Paths are relative to `dir`. */
export function files(dir, limit = 20000) {
  try {
    const out = execFileSync('git', ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024, timeout: 5000 });
    return out.split('\0').filter((f) => f && !/[\x00-\x1f\x7f]/.test(f)).slice(0, limit);
  } catch { /* not a git repo (or no git): walk instead */ }
  const found = []; const skip = new Set(['node_modules', '.git', '.hatch', '.cache', '__pycache__', 'dist', 'build']);
  const walk = (d, rel, depth) => {
    if (found.length >= limit || depth > 8) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (found.length >= limit) return;
      if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1); }
      else if (e.isFile()) found.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(dir, '', 0);
  return found;
}

export function tasks(dir) {
  const out = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const pm = fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(dir, 'yarn.lock')) ? 'yarn' : 'npm';
    for (const [name, body] of Object.entries(pkg.scripts || {})) out.push({ name, cmd: `${pm} run ${/^[\w:.@/-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`}`, source: 'package.json', detail: String(body).slice(0, 80) });
  } catch { /* no package.json, or not valid JSON: nothing to offer */ }
  try {
    for (const f of ['Makefile', 'makefile', 'GNUmakefile']) {
      const file = path.join(dir, f); if (!fs.existsSync(file)) continue;
      const seen = new Set();
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line); // a target, not a variable assignment (:=)
        if (m && !seen.has(m[1]) && !m[1].startsWith('.')) { seen.add(m[1]); out.push({ name: m[1], cmd: `make ${m[1]}`, source: f, detail: '' }); }
      }
      break;
    }
  } catch { /* unreadable Makefile */ }
  return out;
}

/** Listening TCP ports (IPv4 and IPv6) with the process that owns them when /proc allows reading it. */
export function ports(procRoot = '/proc') {
  const listening = new Map(); // port -> { inode, addr }
  for (const f of ['net/tcp', 'net/tcp6']) {
    let text; try { text = fs.readFileSync(path.join(procRoot, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/); if (c.length < 10 || c[3] !== '0A') continue; // 0A = LISTEN
      const [addrHex, portHex] = c[1].split(':'); const port = parseInt(portHex, 16);
      if (!listening.has(port)) listening.set(port, { inode: c[9], // loopback as /proc prints it: 127.0.0.1, ::1 and ::ffff:127.0.0.1
        loopback: /^(0100007F|0{24}01000000|0{16}FFFF00000100007F)$/i.test(addrHex), any: /^0+$/.test(addrHex) });
    }
  }
  const owners = new Map(); // inode -> process name
  try {
    const want = new Set([...listening.values()].map((v) => v.inode));
    if (want.size) for (const pid of fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n))) {
      let fds; try { fds = fs.readdirSync(path.join(procRoot, pid, 'fd')); } catch { continue; }
      for (const fd of fds) {
        let t; try { t = fs.readlinkSync(path.join(procRoot, pid, 'fd', fd)); } catch { continue; }
        const m = /^socket:\[(\d+)\]$/.exec(t);
        if (m && want.has(m[1]) && !owners.has(m[1])) { try { owners.set(m[1], fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim()); } catch { /* gone */ } }
      }
      if (owners.size === want.size) break; // every listener has an owner: stop scanning
    }
  } catch { /* no /proc */ }
  return [...listening].map(([port, v]) => ({ port, process: owners.get(v.inode) || null, scope: v.loopback ? 'localhost only' : v.any ? 'all interfaces' : 'one address' })).sort((a, b) => a.port - b.port);
}
