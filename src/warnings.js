// The warnings behind the header bell. Each source is a function (ctx) -> [{ source, id, message, fix }]: `message` says what is
// wrong, `fix` is the exact command (or step) that clears it. To add a source, write one function and list it in SOURCES;
// a source that throws is skipped, so one broken check never hides the others.
import fs from 'node:fs';
import path from 'node:path';
import { shippedWidgets, widgetStatus, staleProjectCopies } from './update-widgets.js';
import { readTokenAge } from './token.js';

/** Installed widget copies whose shipped example has changed since they were copied (see update-widgets.js). */
export function outdatedWidgets({ stateDir }) {
  const root = path.join(stateDir, 'widgets');
  const names = shippedWidgets().filter((n) => fs.existsSync(path.join(root, n)) && widgetStatus(stateDir, n) === 'stale');
  for (const n of staleProjectCopies(stateDir)) if (!names.includes(n)) names.push(n); // per-project git widgets (git-<folder>)
  return names.sort().map((n) => ({ source: 'widgets', id: `widget:${n}`, message: `The ${n} widget is older than the version shipped with Hatch.`, fix: `hatch-server update-widgets ${n}` }));
}

/** The login token has not changed for more than 30 days. */
export function oldToken({ stateDir, now }) {
  const t = readTokenAge(stateDir, now);
  return t.stale ? [{ source: 'token', id: 'token-age', message: `The login token is ${t.ageDays} days old.`, fix: 'hatch-server rotate-token (if you changed it by hand: hatch-server token touch)' }] : [];
}

export const SOURCES = [outdatedWidgets, oldToken];

export function collectWarnings(ctx, sources = SOURCES) {
  const out = [];
  for (const s of sources) { try { out.push(...s(ctx)); } catch { /* skip a failing check */ } }
  return out;
}
