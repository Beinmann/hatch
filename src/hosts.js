// Rejects unexpected Host headers (DNS rebinding): a page on evil.example that resolves to the box must not be able
// to talk to it. IP literals, localhost and this machine's own name are fine; anything else must be listed in
// `allowedHosts` in config.json, in `allowed-hosts` in the state dir (one per line) or in HATCH_ALLOW_HOSTS (comma
// separated, `*.suffix` wildcards allowed).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

export const parseHosts = (text) => String(text || '').split(/[,\n]/).map((h) => h.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean);
export const hostMatches = (entry, host) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : entry === host);

/** `Host` header value -> bare lower-case host name without port. */
export function bareHost(header) {
  const h = String(header || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

export function hostAllowed(header, extra = []) {
  const host = bareHost(header);
  if (!host) return false;
  if (net.isIP(host) || host === 'localhost' || host === os.hostname().toLowerCase()) return true;
  return [...extra, ...parseHosts(process.env.HATCH_ALLOW_HOSTS)].some((e) => hostMatches(e, host));
}

/** Hosts from `<state>/allowed-hosts` (one per line, `#` comments). Missing file: none; unreadable: none plus a warning. */
export function readAllowedHostsFile(dir, warn = () => {}) {
  const file = path.join(dir, 'allowed-hosts');
  try { return parseHosts(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') warn(`cannot read ${file}: ${e.message}; hosts listed there are not allowed until it is readable`); return []; }
}

export const hostRefusedMessage = (header) => `Host ${header} is not allowed (DNS rebinding guard). Allow it by adding "${bareHost(header)}" on its own line to .hatch/allowed-hosts (kept when the state is cleared), to "allowedHosts" in .hatch/config.json, or to HATCH_ALLOW_HOSTS; then restart Hatch.`;
