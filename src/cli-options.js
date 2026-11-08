// Shared routing knowledge keeps global options before a command consistent across both entrypoints.
export const BOOLEAN_OPTIONS = new Set(['help', 'version', 'json', 'no-enter', 'text', 'direct', 'wait', 'open', 'always', 'force', 'full', 'fullscreen', 'no-focus', 'view-only', 'tmux-status', 'view', 'revoke-view', 'yes']);
// Commands that moved from `hatch` to `hatch-server`; `hatch` still forwards them with a notice.
export const SERVER_COMMANDS = new Set(['serve', 'start', 'stop', 'restart', 'status', 'url', 'service']);

export function firstCommandIndex(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return i + 1 < argv.length ? i + 1 : -1;
    if (arg === '-h') continue;
    if (!arg.startsWith('--')) return i;
    const [key] = arg.slice(2).split('=');
    if (!arg.includes('=') && !BOOLEAN_OPTIONS.has(key)) i++;
  }
  return -1;
}

export function withoutOption(argv, name) {
  const result = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) { i++; continue; }
    if (!argv[i].startsWith(`--${name}=`)) result.push(argv[i]);
  }
  return result;
}
