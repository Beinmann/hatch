# Customising Hatch (init.el style)

Two optional files in the state dir (`~/.hatch/` by default) are loaded by the page when they exist. They are yours: Hatch never writes them.

## Background image

`hatch set background IMAGE` (also `hatch set background IMAGE`) copies a PNG, JPEG, GIF or WebP file into the state dir as
`background.<ext>`, replacing an earlier one. Open pages show it without a reload and it stays after a restart. The type is
checked from the file header; anything else (missing file, text, SVG, BMP) is refused with a message and the current background
is kept. Convert other formats first, e.g. `convert in.bmp out.png`. The file is the source of truth: copy a new image over
`~/.hatch/background.png` by hand and the page follows; delete it to go back to the plain theme; a broken file shows a warning
and no background. The terminal and dock turn translucent while a background is set.

`hatch set background none` removes the image. `hatch set background-mode MODE` chooses the fit: `fill` (cover, the
default), `fit` (contain), `stretch`, `center` or `tile`. It is kept in `~/.hatch/background.json` as `{"mode":"fill"}`; edit it
by hand if you like. An unknown mode or broken file shows a warning and uses `fill`.

`hatch set transparency N` (0 to 100, default 30, so a background image shows through; 0 = fully opaque, which hides the image behind the terminal) makes the terminal and the panels translucent so the page
background shows through; `set transparency 0` gives the opaque look. It is kept in `~/.hatch/transparency.json` as
`{"percent":30}`; edit it by hand if you like. An invalid value is refused and the saved one stays; a broken file shows a
warning and uses 30.

**Window transparency.** Windows (widgets included) that were never set one by one with leader `o` are opaque (0) by default and do not follow the page transparency above.
`hatch set window-transparency N` (0 to 100; above 80 is capped at 80 so a window cannot vanish) gives those windows another default,
`hatch set window-transparency follow` makes them follow the terminal/page transparency (the behaviour of older versions), and
`hatch set window-transparency default` goes back to 0 (it removes the stored value). The same is in the command palette ("Windows: set default
transparency..."). It is the optional `"windows"` field of `transparency.json` (`{"percent":30,"windows":0}`, or `"windows":"follow"`), applies to
open windows at once, and a window set with leader `o` keeps its own value. Upgrading: a `transparency.json` without `windows` now gives opaque
windows; run `hatch set window-transparency follow` to keep the old look.

`hatch windows transparency N` (0 to 100, capped at 80) sets the transparency of every window that is open right now in one go (also in the
palette: "Windows: set transparency of all open windows..."). Each window keeps the value like with leader `o`, so it overrides the defaults above;
windows opened later are not affected.

**Background effects.** `hatch fx matrix` (dim film-style digital rain), `hatch fx rain` (water drops of mixed sizes on a pane of glass that bend the page background, shrinking as they evaporate while new ones keep appearing at a steady pace, rarely one runs down, with a faint thin background rain slanting from upper right to lower left; WebGL, with a plain 2D fallback), `hatch fx goo` (many thin black strands of goo, up to a limited but long length, hanging from the letters on screen, each ending in a small drop that only forms at the end; a strand falls only once its neck at the text has pinched off or its letter is gone), or one of the calm 2D ones: `hatch fx snow`, `starfield`, `aurora` (slow green and violet curtains), `fireflies`, `embers` (rising sparks) or `waves` (translucent swells along the bottom). `hatch fx list` lists all effects and marks the active one. It draws an animated
canvas behind the terminal text; `hatch fx off` removes it and `hatch fx` shows what is active. The terminal's own background is always
transparent, and the canvas has its own opaque base, so the effect shows at any transparency setting (including 0). It takes no mouse or
keyboard input, pauses in a hidden tab, is capped at 30 frames per second and shows one still frame when the system asks for reduced motion.
`goo` anchors its drips to the text cells the terminal currently shows: they follow the text when it scrolls and let go when their letter is gone.
`hatch fx rain --intensity 30` sets how strong the effect is, 0 to 100 (default 50); it is remembered per effect, `hatch fx NAME` keeps the stored value, and
`hatch fx --intensity N` without a name changes the active effect. Open pages apply a new intensity live.
The choice lives in `~/.hatch/fx.json` (`{"effect":"rain","intensity":{"rain":30}}`; the `intensity` part is optional; delete the file or write `"off"` to clear the effect; a bad file or value warns and means off or the default of 50) and open
pages follow it by themselves. While an effect is on the header shows a small `fx: hatch fx off` button that turns it off; the palette has one entry per effect plus "stronger" and "weaker" (steps of 20). To add an effect, drop a module with `start(canvas, {animate, intensity, terminal})`, `setIntensity(n)`, `stop()` and `resize()` into `public/fx/`, register it in `public/fx.js` and add its name to `src/fx.js`. `terminal` is a read-only view of the xterm screen (`cols`, `rows`, `cellSize()`, `cellsWithText()`, `charAt()`, `viewportY()`, `onChange(cb)`; see `public/fx-terminal.js`) or `null`; effects that do not need it ignore it. The rain timings are in `P` in `public/fx/rain-sim.js` (`LIFE` = how long a drop lives and shrinks, `DENSITY`, `RUN_EVERY` = seconds between running drops, `RUN_SHRINK`) the shrink and fade shape in `dropLook` in `public/fx/rain-physics.js`, which also holds the `STREAKS` table of the background rain (`angleDeg`, per-lane `width` and `weight`, overall `max`; its strength is `RAIN` in `public/fx/rain.js`). The goo colours are at the top of `public/fx/goo.js`, its timings and sizes in the `CFG` table of `public/fx/goo-physics.js`.

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
// ~/.hatch/custom.js
hatchUI.addCommand('Deploy staging', () => hatchUI.api('POST', '/api/runs', { cmd: './deploy.sh staging' })
  .then((r) => hatchUI.api('POST', '/api/panels', { type: 'output', title: 'deploy', props: { cmd: './deploy.sh staging', runId: r.id }, w: 600, h: 320 })), 'runs ./deploy.sh');

hatchUI.on('notify', (n) => { if (n.level === 'warn') document.title = '! ' + n.text.slice(0, 30); });
```

Errors in `custom.js` show as a toast and in the browser console; a missing file is silent. Reload the page to apply changes.
The files run with the full power of the page, so keep them to what you wrote yourself.
