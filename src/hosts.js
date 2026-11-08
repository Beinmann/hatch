// Rejects unexpected Host headers (DNS rebinding): a page on evil.example that resolves to the box must not be able
// to talk to it. IP literals, localhost and this machine's own name are fine; anything else must be listed in
// `allowedHosts` in config.json or in HATCH_ALLOW_HOSTS (comma separated, `*.suffix` wildcards allowed).
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
