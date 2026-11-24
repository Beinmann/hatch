# Feature inventory (for deciding what to keep)

The core of V0.1 is listed first. Everything below that was added on top, so the tool can be judged and cut.
"Seen" = watched working in headless Chromium (emulated, never a real phone, OS clipboard or real Claude session).
Cross-browser: the page also loads, connects the terminal, opens the palette and shows windows in headless Firefox and WebKit
(Safari engine) without console errors, and the end-to-end script (drag, resize, minimise, live widget reload, hand-edited
panel files, reload persistence) passes in WebKit; in Firefox everything passes except the image/text PASTE checks, which
need a real clipboard (Firefox ignores `clipboardData` on a synthesized paste event, so that is the test, not necessarily the
app). Other features were only run in Chromium.
"Tests" = covered by `node --test` (115 tests). Sizes are rough: about 2108 lines of server code, 705 of CLI/MCP, 2094 of browser code and 1695 of tests. Delete a feature by
removing its files and its CLI case, palette entry and README bullet.

## Core

| Feature | Where | Seen | Notes |
|---|---|---|---|
| tmux terminal in the page, reload re-attach | src/terminal.js, public/terminal.js, src/ptyhost.py | yes | the heart of it |
| Any-file upload by drop/paste, path drag | app.js, panels/files.js | synthetic events | |
| Upload button (file picker, touch-first devices only) | public/phone-upload.js, public/app.js | unit-tested detection and handler, page smoke | not tried on a real phone or in a browser |
| Image paste and drop | src/uploads.js, public/app.js | yes (synthesized paste) | |
| State dir, SSE events, windows | src/state.js, src/events.js, public/windows.js | yes | files are the source of truth |
| hatch CLI | bin/ui.js | yes | |
| Progress panel (Mermaid, steps) | public/panels/progress.js, public/vendor/ (2.5 MB) | yes | Mermaid is by far the biggest file in the repo |
| Widgets (SDK, sources) | src/sources.js, public/panels/widget.js, public/sdk.js | yes (cpu) | exec sources run shell commands |

## Added on top (ranked by how much I expect you to keep)

| Feature | Rough size | Seen | Cut cost |
|---|---|---|---|
| Palette calculator, diff-files | calc.js, ui.js | yes (calc) | |
| Quick file finder (/ and @ in the palette) | discover.js files, app.js | yes | |
| Command palette + saved commands | public/palette.js, /api/commands | yes | the hub for most extras: removing it hides many entries |
| Output windows: run, grep, diff, log, man, tail | src/runs.js, panels/output.js | yes (run, grep, diff) | grep/diff/log/man/tail are tiny wrappers on run |
| Clickable file:line and URLs in the terminal | public/terminal.js | yes | |
| File management (new, rename, delete) | files.js, panels/files.js | yes | permanent deletes |
| HTML page window (`hatch open FILE.html`) | src/pages.js, panels/page.js, server /page/ | yes | sandboxed iframe, per-window key, Chromium only |
| Files browser + text editor, image preview pane | src/files.js, panels/files.js, panels/files-preview.js, editor.js | yes (preview helpers) | any-path access unless --root |
| Files window hidden files toggle (`.` with the window focused and no text field active, `. hidden` button, palette entry; `?hidden=1` on `/api/fs/list`; kept in the window's `hidden` prop; dotfiles dimmed) | src/files.js, src/server.js, panels/files.js, app.js | listing, key helper, prop validation and persistence tested; NOT seen in a browser | off by default |
| Ask the user (dialog) | server /api/ask, app.js | yes | |
| Terminal windows | /api/pterm, panels/terminal.js | yes | |
| Noise widget (brown/pink/white/deep/rain noise via Web Audio, play/stop, volume, sleep timer; settings saved) and `hatch noise [brown\|pink\|white\|stop]`, which starts or stops it without bringing anything forward (reuses an open window untouched, else opens one minimized; the browser may ask for one click on Play) | examples/widgets/noise | no (not seen or heard in a browser) | pure client side |
| Decorative widgets (matrix, analog-clock, ascii-donut, quote) | examples/widgets/* | no (not seen in a browser) | pure client side, just for looks |
| Desktop gadgets + graph, clock widgets | examples/widgets/*, server openDesktop | partly | the "looks like a programmer's desktop" part |
| Widget sources over one stream | server /api/sub | yes | a bug fix, keep |
| hatch.call (one-shot source with argument), widget data/ folder, background-roulette widget | server /api/call, sources.js runOnce, examples/widgets/background-roulette | yes | |
| wallpaper-shuffle widget (multi-source download job, favorites, auto timer, two-step delete) | examples/widgets/wallpaper-shuffle, test/wallpaper-shuffle.test.js | yes | replaces background-roulette in practice |
| Customisation (custom.css, custom.js) | app.js hatchUI, server /custom | yes | docs/CUSTOMIZE.md |
| Taskbar and window snapping | windows.js, app.js | yes | |
| Sticky windows, window cycling | windows.js | yes | |
| Workspaces (named, own terminal and background, URL `#name`, tab notice, import) | workspaces.js, windows.js, app.js | yes | one instance replaces several; old state is wrapped as `main` with a backup |
| Progress in the tmux status line (--tmux-status) | server mirrorStatus | tests (real tmux) | opt-in |
| Watches (pattern / idle notify) | src/watches.js | server only | |
| Localhost proxy for iframes | src/proxy.js | yes (HTTP) | WebSocket path tested only with a raw socket |
| Clipboard bridge (copy, OSC 52) | server /api/copy, terminal.js | button path only | |
| Terminal find (Ctrl+Shift+F) | terminal.js | yes | |
| Leader key window control (Ctrl+Space, then h/j/k/l, 1-9, Tab, t, q, m, u, s toggle dock, d dock or release, Shift/Ctrl+hjkl, o per-window transparency, f, a, p, r reload page; configurable in Settings) | leader.js, direction.js, windows.js, app.js | key mapping and focus selection | |
| Move focused window by keyboard (leader Shift+h/j/k/l = 40px, Alt+hjkl/arrows = 1px, Alt+Shift = 10px) | leader.js, windows.js, app.js | key mapping only | not browser-tested |
| Restore minimized widget by keyboard (leader u) | restore.js, windows.js, app.js | selection logic only | not browser-tested |
| curl window, docker widget | ui.js, examples/widgets/docker | curl tested, docker not | |
| Scheduled checks (every) | src/schedules.js | CLI + tests | |
| Export / import of your setup | ui.js | tests | |
| Bookmarks | server /api/bookmarks, ui.js | CLI only | |
| Runnable notes (Run button on shell blocks) | md.js, panels/note.js | yes | |
| Editable notes | note.js | no | |
| Named progress plans (--plan, HATCH_PLAN, one window each) | plans.js, state.js, server.js, panels/progress.js | server and CLI | window not browser-tested |
| Background effects (hatch fx matrix/rain/goo/snow/starfield/aurora/fireflies/embers/ripples/breathing/constellation/off, hatch fx list, --intensity 0-100 per effect) | src/fx.js, public/fx.js, public/fx-terminal.js, public/fx/ | file, API, CLI, stub-canvas runs, goo physics, terminal view against a fake xterm | rain seen in headless Chromium (WebGL and 2d fallback; the steady drop stream, shrinking and slanted thin background rain, balanced between faint and visible, seen as a WebGL screenshot only); goo (reworked drips), snow, starfield, aurora, fireflies, and embers seen as headless Chromium screenshots against a fake terminal view and plain text (no real xterm, no animation judged beyond a few seconds); the anchoring of goo to real xterm text never seen |
| Progress timeline | progress.js | yes | |
| Recent files, clipboard history, find-file | app.js | partly | |
| Saved prompts, Zen mode, workspace chords | app.js, ui.js | yes | |
| Welcome card | app.js | yes | |
| Client error log, Show server log | app.js, server /api/clientlog | yes | |
| Notification log, shortcuts overlay | app.js | yes | |
| Git window (stage, commit, diffs) | src/git.js, panels/git.js | yes | no push/pull/discard |
| exec placeholders in widget sources | sources.js, server.js | yes | |
| Git status widget (sections, "Latest commits on BRANCH", other branches grouped under activity, per-project instances via `hatch widget open git`) + two-step Commit button (headless agent) | examples/widgets/git, server openGitFor | parser and server, not seen in a browser | read-only |
| Files widget (`hatch widget open files`: read-only browser, hjkl/arrows/mouse, hidden toggle, image/text/metadata preview) | examples/widgets/files, server openFilesFor, sources.js maxBytes | model, source commands and server tested; seen in headless Chromium (keys, preview, images decode, permission message; text glyphs not visible there) | read-only; images over 2 MB and text past 64 KB are not shown in full; lists at most 3000 entries |
| Board widget (PROTOTYPE: pan/zoom canvas, text cards, arrows, saved to data/board.json via exec sources) | examples/widgets/board, test/board.test.js | headless Chromium only (layout and interaction; text glyphs not visible there) | model in model.js (incl. undo/redo history and arrow-drag card creation) is node-tested, the undo/redo and drag-created-card UI not seen in a browser; plain text only |
| Board widget (PROTOTYPE: pan/zoom canvas, text cards, arrows, saved to data/board.json via exec sources) | examples/widgets/board, test/board.test.js | headless Chromium only (layout and interaction; text glyphs not visible there) | model in model.js (incl. undo/redo history and arrow-drag card creation) is node-tested, the undo/redo and drag-created-card UI not seen in a browser; plain text only; `hatch widget open board FILE.board.json` autosaves to that file (server and CLI tested, not seen in a browser): a file over 64 KB cannot be loaded back (exec output limit) and a changed file is not reloaded while the widget is open; per-file copies are not refreshed by `update-widgets` |
| Board node types and nested boards (type picker, board card with breadcrumb, cut/paste across levels, move into new board) | examples/widgets/board, src/board-file.js, test/board.test.js | headless Chromium: all types created, board opened, count and preview refreshed, delete confirmation, move into board, files on disk (text glyphs are not visible there, so type looks were not judged by eye) | model and storage node-tested; title-bar path button for inner boards and cut/paste between levels in the page not seen |
| Board files: every board is a *.board.json (default in the state dir, kept when the window is closed or the widget removed), `widget boards` lists known files, curved arrows around cards | src/board-file.js, examples/widgets/board, test/board.test.js, test/board-layout.test.js | server and CLI by tests; the curves and the title-bar path button are not browser-tested for this change | |
| Widget layout per directory (`hatch widget save| - | src/widget-layout.js, bin/hatch.js, test/cli.test.js | CLI and server API, not seen in a browser | layout only; widgets not installed here are skipped with a warning; a saved minimized state is not re-applied |
| Header: server state (dot + online/offline) next to the name; icon-only Dock button (always visible; the dock column auto-hides when its last window leaves and opens empty with a hint); "⋯" more-options menu (Commands, Settings, Progress only when PROGRESS_UI is on, New/Switch/Rename workspace; Escape, outside click, arrow keys); workspace chips and "+" only with 2+ workspaces | public/more-menu.js, public/index.html, public/app.js, public/style.css, test/more-menu.test.js | entry list, chip rule, arrow-key wrap | seen in headless Chromium (see notes in the commit) | |
| Window numbers on title bars (dimmed always, `N` or folder `N.m`; bright while leader/Ctrl held; taskbar chips always show a dim slot number 1-9, bright while held; Settings toggle "Always show window numbers") | public/folder-keys.js (windowLabel), public/windows.js, public/style.css, public/app.js, test/window-label.test.js | label logic; seen in headless Chromium: loose, folder member, docked, toggle off and its persistence, held numbers, Zen and peek hide it | not on touch devices | |
| Window folders (`hatch folder new|remove|rename|show|hide|delete|list`; taskbar chip with a members bubble; drag a chip onto another to group; Shift/Ctrl+click show/hide all; Ctrl+N shows a hidden folder or asks for a sub number (0 hides all; Ctrl+N again picks member N); Ctrl+0 selects the terminal; leader+N then a digit picks a member) | - | public/folders.js, public/folder-keys.js, public/windows.js, src/state.js, bin/hatch.js, test/folders.test.js, test/folder-keys.test.js | pure logic, server and CLI tested; UI seen in headless Chromium (drag to group, bubble, restore, take out, reload); not on touch devices | flat, per workspace; one row of slots shared by loose chips and folder chips (public/taskbar-order.js, saved per browser and workspace); leader-u selection has no chip for a folder member |
| Notebook widget (Python cells, markdown cells, one long-lived kernel per window, notebook file per window) + `proc` widget sources and `perWindow` copies | examples/widgets/notebook (runner.py, index.html), src/procs.js, src/sources.js, src/server.js, test/notebook.test.js | runner protocol and server side by tests (real python3); page driven in headless Chromium (run, Shift+Enter, table, Stop, variables kept, reload, Hatch restart banner and Run all, window close removes notebook and kernel; text glyphs are not visible there, so looks were not judged by eye) | matplotlib images only tested when matplotlib is installed (it was not on the dev box, so only the without-matplotlib path was run); Linux/macOS only; no sandbox, no timeout |
| Tide widget (PROTOTYPE: planner for one day, loose cards + scrolling timeline, shove on drop, padlock, split into goals, plan snapshot, categories, day file + archive) | examples/widgets/tide, test/tide.test.js | model and the load/save files by tests (including the one-file-per-day layout); the page itself is NOT seen in a browser | the UI (drag, resize, menus, hover, scroll) is untested; no CLI or AI triage yet |
| ports metric, ports and pomodoro widgets | sources.js, examples/widgets | yes | |
| Task runner, listening ports | src/discover.js | tests only | |
| Session report | server /api/report, ui.js | CLI only | |
| Maximize | windows.js | yes | |
| Show desktop (leader Shift+d): minimize all, again restores the same formation | show-desktop.js, windows.js, app.js | planning and change detection | not browser-tested |
| Dock look: opaque column (surface colour mixed 6% toward the text colour, so it separates from the widgets) with an inset divider, darker widgets, 30px padding on the left and 14px on the right; no scroll bar at all, the wheel scrolls the dock over its padding, gaps and non-scrolling content (not over widget iframes, which take the wheel); the dock's left edge (5px, col-resize) resizes it (120px to 70% of the window, remembered) | windows.js, style.css | - | not yet seen in a browser |
| Peek: hold Alt alone to hide the floating windows (dock, fx and background stay) (key in Settings; other keys end it) | peek.js, style.css, app.js | state machine (timing, cancel, reset) | seen in headless Chromium: hold, release, Alt+b, other key, blur; not Firefox or Windows menu-bar behaviour |
| Tile / minimize-all / close-all | app.js | tile only | |
| Phone layout + extra keys bar | style.css, app.js | emulated | |
| Font size memory | app.js | no | |
| MCP server | bin/mcp.js | tested with a script client only | |
| Skill package | .claude/skills/hatch | no | |
| systemd unit printer | bin/hatch.js | text only | untested in systemd |
| --view-only mirror and view token | src/server.js viewAllowed | yes | |
| --root file confinement | src/files.js | tests only | |
| Review fixes (two rounds) | various | tests, browser regression | keep |

## Not done / known gaps

Login: `/login`, hashed server-side sessions, rotate-token, single-use login links, per-address failed-login limit, hosted-page sandbox with per-load secrets (test/login.test.js, test/host-auth.test.js; the login page and a hosted multi-file page were seen in headless Chromium). See `docs/SECURITY.md`.

The security pass is mostly open: widget files and /sdk.js are served without the token, `/proxy/PORT` reaches any local
port and proxied pages share Hatch's origin, run/term/exec commands are unrestricted. Never tried: a real phone, a real
OS clipboard, drag-drop of real files, Claude Code reading a pasted image, Claude building a widget from the snippet.

## Cut

Removed after the first review on 2026-11-08. They overlapped with something else, had no current use case,
or were unrelated to the main workflows. Old state files of these (`layouts/`, `recordings/`, theme blocks in `custom.css`,
saved macros in `commands.json`) are ignored without a warning. Macros and the hub are possible future work.

| Feature | What went |
|---|---|
| Saved layouts | `/api/layouts`, `hatch layout`, palette entries (workspaces and the leader key stay) |
| TODO list | `hatch todo`, `hatch_todo_add`, the TODO section of the session report (checkboxes in notes stay: they work in any note) |
| Palette timers | `timer` entries in the palette (`watch` and `every` stay) |
| Keyboard macros | recording and playback in `terminal.js`, palette entries, the `macro` flag of saved commands |
| Terminal recording and playback | `src/record.js`, the player panel, `hatch record|play`, `/api/record` |
| Tickets board widget | `examples/widgets/tickets` |
| System tray | the cpu/memory/load readout in the header and Settings and the server's `stats` events (the cpu, mem and load widget sources stay) |
| Colour themes | `src/themes.js`, `hatch theme`, the theme picker in Settings (one fixed default; it follows the system light/dark setting) |
| Hub for several boxes | `src/hub.js`, `hatch-server hub`, `hub add`, its page |
