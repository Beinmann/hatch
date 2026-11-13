// Screenshots of a widget window (a board, say) without a headless browser: `hatch widget screenshot` asks the server, the
// server relays the request to one open browser tab, that tab renders the widget itself (public/shot.js) and posts the PNG
// back. This module holds the pending requests and the name lookup; server.js wires it to the event bus and the routes.
import crypto from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** The widget window a name points at: panel id, widget name, board file name (`plan` or `plan.board.json` for
 *  board-plan), or title. Panels of the asked workspace win; several matches are an error. */
export function findWidgetPanel(panels, name, ws = 'main') {
  const want = String(name ?? '').trim();
  if (!want) throw fail(400, 'screenshot needs the name of an open widget or board window (hatch widget list)');
  const slug = want.replace(/\.board\.json$/, '').split('/').pop().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  const widgets = panels.filter((p) => p.type === 'widget');
  const lc = want.toLowerCase();
  const tiers = [(p) => p.id === want, (p) => p.props?.name === want, (p) => p.props?.name === `board-${slug}`, (p) => String(p.title || '').toLowerCase() === lc];
  for (const test of tiers) {
    const hits = widgets.filter(test); if (!hits.length) continue;
    const here = hits.filter((p) => (p.ws || 'main') === ws);
    const use = here.length ? here : hits;
    if (use.length > 1) throw fail(409, `more than one window matches "${want}": ${use.map((p) => p.id).join(', ')}; use a window id (hatch panels)`);
    return use[0];
  }
  throw fail(404, `no open widget or board window "${want}"; open it first (hatch widget open board FILE.board.json) and check hatch panels`);
}

export function createScreenshots({ emit, timeoutMs = 30000 } = {}) {
  const pending = new Map();
  return {
    /** Sends the request to one browser tab (`pick` chooses which). Rejects when none can take it, or none answers in time. */
    request({ panel, abstract = false, scale = 2 }, pick) {
      const id = `s${crypto.randomBytes(6).toString('hex')}`;
      let taken = false;
      const sent = emit('screenshot', { id, panel, abstract: !!abstract, scale }, (c) => { if (taken || !pick(c)) return false; taken = true; return true; });
      if (!sent) return Promise.reject(fail(409, 'no Hatch browser tab is open to render the screenshot (full access, showing that window\'s workspace); open the Hatch page in a browser and try again'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(fail(504, `the browser did not answer within ${Math.round(timeoutMs / 1000)} s; is the window minimized, or the tab in the background? (screenshots need the widget to use /sdk.js)`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
    },
    /** The tab's answer: { png: base64, width, height } or { error }. */
    answer(id, body) {
      const p = pending.get(id); if (!p) throw fail(404, `no screenshot request ${id} (it timed out, or was already answered)`);
      pending.delete(id); clearTimeout(p.timer);
      if (typeof body.error === 'string' && body.error) return p.reject(fail(502, `the browser could not render it: ${body.error.slice(0, 300)}`));
      if (typeof body.png !== 'string' || !body.png) return p.reject(fail(502, 'the browser sent no image'));
      p.resolve({ png: body.png, width: Number(body.width) || 0, height: Number(body.height) || 0 });
    },
    pending: () => pending.size,
  };
}
