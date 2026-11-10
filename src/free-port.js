// Port choice for `hatch-server serve`. Without --port the server wants 7070; when that is taken it tries the next ports
// in turn and saves the one it got in config.json (listen() does that), so a second instance on the same box needs no flags
// and its clients find it through the config file. An explicit --port that is taken is an error, never a silent move.
export const DEFAULT_PORT = 7070;
const TRIES = 50;

/** Calls hatch.listen(port) from `first` upwards while the port is in use. Resolves { port, moved }.
 *  `explicit`: never move, let the EADDRINUSE error through. */
export async function listenFromPort(hatch, first, { explicit = false, tries = TRIES } = {}) {
  for (let port = first; ; port++) {
    try { await hatch.listen(port); return { port: hatch.server.address().port, moved: port !== first }; }
    catch (e) { if (explicit || e.code !== 'EADDRINUSE' || port - first + 1 >= tries || port >= 65535) throw e; }
  }
}
