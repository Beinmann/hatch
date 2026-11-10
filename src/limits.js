// Plan limits of the Claude account (5-hour and weekly windows), as the Claude CLI itself reports them: a headless
// run emits a `rate_limit_event` with the utilization of both windows. No token is read and no private endpoint is
// called; one tiny run (smallest model, no tools) fetches fresh figures, at most once per TTL unless forced.
import os from 'node:os';
import { spawn } from 'node:child_process';

const WINDOWS = [['fiveHour', 'five_hour', '5-hour'], ['sevenDay', 'seven_day', 'Weekly']];
const TTL_MS = 10 * 60 * 1000;      // the page polls; a probe run happens at most this often
const FORCE_MIN_MS = 30 * 1000;     // a manual refresh cannot spam runs either

/** Pulls `{ fiveHour: { label, percent, resetsAt }, sevenDay: {...} }` out of a stream event, or null if it has none. */
export function parseRateLimitEvent(ev) {
  const info = ev?.type === 'rate_limit_event' ? ev.rate_limit_info : null;
  if (!info) return null;
  const windows = { ...info.unifiedWindows };
  if (info.rateLimitType && typeof info.utilization === 'number' && !windows[info.rateLimitType]) windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
  const out = {};
  for (const [key, field, label] of WINDOWS) {
    const w = windows[field];
    if (w && typeof w.utilization === 'number') out[key] = { label, percent: w.utilization * 100, resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null };
  }
  return Object.keys(out).length ? out : null;
}

/** Runs `claude -p` once and resolves with the limits from its stream-json output; rejects with a readable message. */
export function defaultProbe({ bin = 'claude', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', 'Reply with ok.', '--output-format', 'stream-json', '--verbose', '--tools', '', '--model', 'haiku', '--max-budget-usd', '0.05'];
    let child; let found = null; let buf = ''; let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } reject(new Error('the Claude CLI did not answer within 60 s')); }, timeoutMs);
    const line = (l) => { try { found = parseRateLimitEvent(JSON.parse(l)) || found; } catch { /* not JSON */ } };
    try { child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { clearTimeout(timer); return reject(e); }
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `"${bin}" not found: install the Claude Code CLI and put it on PATH` : e.message)); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    child.on('close', (code) => { clearTimeout(timer); line(buf); found ? resolve(found) : reject(new Error(err.trim() || `claude exited with code ${code} and reported no limits`)); });
  });
}

/** `{ claude: { fiveHour, sevenDay, fetchedAt } }` or `{ claude: { error } }`; never throws. */
export function createLimits({ probe = defaultProbe, now = Date.now } = {}) {
  let cached = null; let at = 0; let inflight = null;
  async function refetch() {
    try {
      cached = { ...(await probe()), fetchedAt: new Date(now()).toISOString() };
    } catch (e) {
      cached = cached && !cached.error ? { ...cached, stale: e.message } : { error: `could not read the limits from the Claude CLI: ${e.message}` };
    }
    at = now();
    return { claude: cached };
  }
  return {
    async get(force = false) {
      const age = now() - at;
      if (cached && age < (force ? FORCE_MIN_MS : TTL_MS)) return { claude: cached };
      return (inflight ||= refetch().finally(() => { inflight = null; }));
    },
  };
}
