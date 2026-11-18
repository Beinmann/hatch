// Plan limits of the Claude account (5-hour and weekly windows), as the Claude CLI itself reports them: a headless
// run emits a `rate_limit_event` with the utilization of both windows. No token is read and no private endpoint is
// called; one tiny run (smallest model, no tools) fetches fresh figures, at most once per TTL unless forced.
import { runClaude } from './claude-p.js';

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
export async function defaultProbe({ timeoutMs = 60000 } = {}) {
  const out = await runClaude({ prompt: 'Reply with ok.', timeoutMs, extra: ['--output-format', 'stream-json', '--verbose'] });
  let found = null;
  for (const l of out.split('\n')) { try { found = parseRateLimitEvent(JSON.parse(l)) || found; } catch { /* not JSON */ } }
  if (!found) throw new Error('claude ran but reported no limits');
  return found;
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
