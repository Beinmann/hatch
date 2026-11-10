// Loads public/app.js in Node against permissive DOM stubs, to catch errors that stop the page script before the terminal exists
// (a ReferenceError from using a const too early, a bad import). It checks nothing about layout or behaviour. Used by page-smoke.test.js.
const mk = (name) => new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === 'length' ? 0 : k === Symbol.iterator ? function* () {} : (k in t ? t[k] : mk(name + '.' + String(k))),
  apply: () => mk(name + '()'), construct: () => mk('new ' + name), set: () => true, has: () => true,
});
const ls = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const g = globalThis;
g.window = g; g.self = g; g.document = mk('document'); g.location = { href: 'http://x/?t=abc', search: '?t=abc', origin: 'http://x', hostname: 'x', protocol: 'http:', host: 'x', pathname: '/', hash: '' };
g.history = mk('history'); g.localStorage = ls; g.sessionStorage = ls; g.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
g.EventSource = class { addEventListener() {} close() {} }; g.ResizeObserver = class { observe() {} disconnect() {} }; g.MutationObserver = g.ResizeObserver; g.IntersectionObserver = g.ResizeObserver;
g.addEventListener = () => {}; g.removeEventListener = () => {}; g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); g.getComputedStyle = () => ({ getPropertyValue: () => '' });
g.devicePixelRatio = 1; g.innerWidth = 1200; g.innerHeight = 800; g.WebSocket = class {}; g.Notification = mk('Notification'); g.AudioContext = class {};
g.HTMLElement = class {}; g.Element = class {}; g.Node = class {}; g.CSS = { supports: () => true }; g.performance = g.performance || { now: Date.now };
try { Object.defineProperty(g, 'navigator', { value: mk('navigator'), configurable: true }); } catch {}
process.on('unhandledRejection', (e) => console.log('UNHANDLED REJECTION:', e?.stack?.split('\n').slice(0, 3).join(' | ')));
try { await import(process.argv[2]); await new Promise((r) => setTimeout(r, 300)); console.log('app.js top level ran to the end'); process.exit(0); }
catch (e) { console.log('TOP-LEVEL ERROR:', e.stack.split('\n').slice(0, 5).join('\n')); process.exit(1); }
