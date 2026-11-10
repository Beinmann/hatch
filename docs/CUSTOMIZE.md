# Customising Hatch (init.el style)

Two optional files in the state dir (`.hatch/`) are loaded by the page when they exist. They are yours: Hatch never writes them.

## Background image

`hatch set background IMAGE` (also `hatch set background IMAGE`) copies a PNG, JPEG, GIF or WebP file into the state dir as
`background.<ext>`, replacing an earlier one. Open pages show it without a reload and it stays after a restart. The type is
checked from the file header; anything else (missing file, text, SVG, BMP) is refused with a message and the current background
is kept. Convert other formats first, e.g. `convert in.bmp out.png`. The file is the source of truth: copy a new image over
`.hatch/background.png` by hand and the page follows; delete it to go back to the plain theme; a broken file shows a warning
and no background. The terminal and dock turn translucent while a background is set.

`hatch set background none` removes the image. `hatch set background-mode MODE` chooses the fit: `fill` (cover, the
default), `fit` (contain), `stretch`, `center` or `tile`. It is kept in `.hatch/background.json` as `{"mode":"fill"}`; edit it
by hand if you like. An unknown mode or broken file shows a warning and uses `fill`.

`hatch set transparency N` (0 to 100, default 30, so a background image shows through; 0 = fully opaque, which hides the image behind the terminal) makes the terminal and the panels translucent so the page
background shows through; `set transparency 0` gives the opaque look. It is kept in `.hatch/transparency.json` as
`{"percent":30}`; edit it by hand if you like. An invalid value is refused and the saved one stays; a broken file shows a
warning and uses 30.

**Background effects.** `hatch fx matrix` (dim film-style digital rain) or `hatch fx rain` (rain running down a pane of glass) draws an animated
canvas behind the terminal text; `hatch fx off` removes it and `hatch fx` shows what is active. The terminal's own background is always
transparent, and the canvas has its own opaque base, so the effect shows at any transparency setting (including 0). It takes no mouse or
keyboard input, pauses in a hidden tab, is capped at 30 frames per second and shows one still frame when the system asks for reduced motion.
The choice lives in `.hatch/fx.json` (`{"effect":"matrix"}`; delete it or write `"off"` to clear it; a bad file warns and means off) and open
pages follow it by themselves. While an effect is on the header shows a small `fx: hatch fx off` button that turns it off; the palette has one entry per effect. To add an effect, drop a module with `start(canvas, {animate})`, `stop()` and `resize()` into `public/fx/`, register it in `public/fx.js` and add its name to `src/fx.js`.

## `custom.css`

Override the palette variables or anything else.

```css
:root { --accent: #ff8800; --term: #101820; }
#bar { font-size: 13px; }
.win { border-radius: 10px; }
```

## `custom.js`

A plain ES module, run once when the page loads. `window.hatchUI` is the API:

| | |
|---|---|
| `hatchUI.addCommand(label, fn, hint?)` | adds an entry to the command palette |
| `hatchUI.on(event, fn)` | `notify`, `progress`: called with the event data |
| `hatchUI.api(method, url, body?)` | the same HTTP calls the page makes (panels, runs, terminal input, ...) |
| `hatchUI.term.type(text)` / `.sendText(text)` | type keys (with `\r` for Enter) or paste into the terminal |
| `hatchUI.toast(text, level?)`, `hatchUI.notify({text, level})` | messages |
| `hatchUI.wm`, `hatchUI.ctx`, `hatchUI.store` | the window manager, panel context and per-browser storage |

```js
// .hatch/custom.js
hatchUI.addCommand('Deploy staging', () => hatchUI.api('POST', '/api/runs', { cmd: './deploy.sh staging' })
  .then((r) => hatchUI.api('POST', '/api/panels', { type: 'output', title: 'deploy', props: { cmd: './deploy.sh staging', runId: r.id }, w: 600, h: 320 })), 'runs ./deploy.sh');

hatchUI.on('notify', (n) => { if (n.level === 'warn') document.title = '! ' + n.text.slice(0, 30); });
```

Errors in `custom.js` show as a toast and in the browser console; a missing file is silent. Reload the page to apply changes.
The files run with the full power of the page, so keep them to what you wrote yourself.
