// Last-resort process handlers for hatch-server.

/**
 * An error nobody caught (a throw in a timer, bus or fs-watch callback) must not take the panels and runs down with it:
 * log it with its stack and keep serving. The routes, pty, runs, proxy and SSE already catch their own errors; this
 * is only the net under them.
 */
export function installCrashHandlers(proc = process, log = (m) => console.error(m)) {
  const show = (what, e) => log(`hatch-server: ${what} (the server keeps running): ${e && e.stack ? e.stack : String(e)}`);
  proc.on('uncaughtException', (e) => show('uncaught exception', e));
  proc.on('unhandledRejection', (e) => show('unhandled promise rejection', e));
}

/**
 * The SIGINT/SIGTERM handler: close the server, then exit. If close() hangs or throws, exit anyway after `timeoutMs`
 * (code 1) so a stuck shutdown cannot ignore the signal.
 */
export function createStop(close, { timeoutMs = 5000, exit = (c) => process.exit(c), log = (m) => console.error(m) } = {}) {
  let stopping = false;
  return async () => {
    if (stopping) return; stopping = true;
    const timer = setTimeout(() => { log(`hatch-server: shutdown did not finish within ${timeoutMs} ms, exiting anyway`); exit(1); }, timeoutMs);
    try { await close(); clearTimeout(timer); exit(0); }
    catch (e) { clearTimeout(timer); log(`hatch-server: error while shutting down: ${e && e.stack ? e.stack : e}`); exit(1); }
  };
}
