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

| Feature | Ticket | Where | Seen | Notes |
|---|---|---|---|---|
| tmux terminal in the page, reload re-attach | 002 | src/terminal.js, public/terminal.js, src/ptyhost.py | yes | the heart of it |
| Any-file upload by drop/paste, path drag | 067 | app.js, panels/files.js | synthetic events | |
| Image paste and drop | 003 | src/uploads.js, public/app.js | yes (synthesized paste) | |
| State dir, SSE events, windows | 004 | src/state.js, src/events.js, public/windows.js | yes | files are the source of truth |
| hatch CLI | 005 | bin/ui.js | yes | |
| Progress panel (Mermaid, steps) | 006 | public/panels/progress.js, public/vendor/ (2.5 MB) | yes | Mermaid is by far the biggest file in the repo |
| Widgets (SDK, sources) | 007 | src/sources.js, public/panels/widget.js, public/sdk.js | yes (cpu) | exec sources run shell commands |

## Added on top (ranked by how much I expect you to keep)

| Feature | Ticket | Rough size | Seen | Cut cost |
|---|---|---|---|---|
| Palette calculator, diff-files | 077 | calc.js, ui.js | yes (calc) | |
| Quick file finder (/ and @ in the palette) | 074 | discover.js files, app.js | yes | |
| Command palette + saved commands | 019 | public/palette.js, /api/commands | yes | the hub for most extras: removing it hides many entries |
| Output windows: run, grep, diff, log, man, tail | 030 036 043 | src/runs.js, panels/output.js | yes (run, grep, diff) | grep/diff/log/man/tail are tiny wrappers on run |
| Clickable file:line and URLs in the terminal | 039 | public/terminal.js | yes | |
| File management (new, rename, delete) | 056 | files.js, panels/files.js | yes | permanent deletes |
| Files browser + text editor | 020 | src/files.js, panels/files.js, editor.js | yes | any-path access unless --root |
| Ask the user (dialog) | 029 | server /api/ask, app.js | yes | |
| Terminal windows | 035 | /api/pterm, panels/terminal.js | yes | |
| Decorative widgets (matrix, analog-clock, ascii-donut, quote) | - | examples/widgets/* | no (not seen in a browser) | pure client side, just for looks |
| Desktop gadgets + graph, clock widgets | 031 021 | examples/widgets/*, server openDesktop | partly | the "looks like a programmer's desktop" part |
| Widget sources over one stream | 032 | server /api/sub | yes | a bug fix, keep |
| hatch.call (one-shot source with argument), widget data/ folder, background-roulette widget | 141 | server /api/call, sources.js runOnce, examples/widgets/background-roulette | yes | |
| Customisation (custom.css, custom.js) | 054 | app.js hatchUI, server /custom | yes | docs/CUSTOMIZE.md |
| Taskbar and window snapping | 053 | windows.js, app.js | yes | |
| Sticky windows, window cycling | 062 | windows.js | yes | |
| Workspaces | 044 | windows.js, app.js | yes | |
| Progress in the tmux status line (--tmux-status) | 080 | server mirrorStatus | tests (real tmux) | opt-in |
| Watches (pattern / idle notify) | 023 | src/watches.js | server only | |
| Localhost proxy for iframes | 026 | src/proxy.js | yes (HTTP) | WebSocket path tested only with a raw socket |
| Clipboard bridge (copy, OSC 52) | 037 | server /api/copy, terminal.js | button path only | |
| Terminal find (Ctrl+Shift+F) | 024 | terminal.js | yes | |
| Leader key window control (Ctrl+Space, then h/j/k/l, 1-9, Tab, t, q, m, u, s toggle dock, d dock or release, Shift/Ctrl+hjkl, o per-window transparency, f, a, p; configurable in Settings) | 142 | leader.js, direction.js, windows.js, app.js | key mapping and focus selection | see ticket Summary for what was browser-checked |
| Move focused window by keyboard (leader Shift+h/j/k/l) | 134 | windows.js, app.js | no | not browser-tested |
| Restore minimized popup by keyboard (leader u) | 135 | restore.js, windows.js, app.js | selection logic only | not browser-tested |
| curl window, docker widget | 060 | ui.js, examples/widgets/docker | curl tested, docker not | |
| Scheduled checks (every) | 059 | src/schedules.js | CLI + tests | |
| Export / import of your setup | 076 | ui.js | tests | |
| Bookmarks | 058 | server /api/bookmarks, ui.js | CLI only | |
| Image annotation | 013 | panels/annotate.js | yes (mouse) | |
| Runnable notes (Run button on shell blocks) | 063 | md.js, panels/note.js | yes | |
| Editable notes | 022 | note.js | no | |
| Named progress plans (--plan, HATCH_PLAN, one window each) | - | plans.js, state.js, server.js, panels/progress.js | server and CLI | window not browser-tested |
| Background effects (hatch fx matrix/rain/goo/off, --intensity 0-100 per effect) | - | src/fx.js, public/fx.js, public/fx-terminal.js, public/fx/ | file, API, CLI, stub-canvas runs, goo physics, terminal view against a fake xterm | rain seen in headless Chromium (WebGL and 2d fallback; the steady drop stream, shrinking and slanted thin background rain, balanced between faint and visible, seen as a WebGL screenshot only); other visuals not seen in a browser (the goo look and its anchoring to real xterm text never seen) |
| Progress timeline | 014 | progress.js | yes | |
| Recent files, clipboard history, find-file | 042 | app.js | partly | |
| Saved prompts, Zen mode, workspace chords | 049 | app.js, ui.js | yes | |
| Welcome card | 064 | app.js | yes | |
| Client error log, Show server log | 070 | app.js, server /api/clientlog | yes | |
| Notification log, shortcuts overlay | 045 034 | app.js | yes | |
| Git window (stage, commit, diffs) | 048 | src/git.js, panels/git.js | yes | no push/pull/discard |
| exec placeholders in widget sources | 057 | sources.js, server.js | yes | |
| Git status widget (sections, per-project instances via `hatch widget open git`) | - | examples/widgets/git, server openGitFor | parser and server, not seen in a browser | read-only |
| ports metric, ports and pomodoro widgets | 051 | sources.js, examples/widgets | yes | |
| Task runner, listening ports | 047 | src/discover.js | tests only | |
| Session report | 046 | server /api/report, ui.js | CLI only | |
| Maximize | 034 | windows.js | yes | |
| Show desktop (leader Shift+d): minimize all, again restores the same formation | - | show-desktop.js, windows.js, app.js | planning and change detection | not browser-tested |
| Tile / minimize-all / close-all | 025 | app.js | tile only | |
| Phone layout + extra keys bar | 015 | style.css, app.js | emulated | |
| Font size memory | 028 | app.js | no | |
| MCP server | 010 | bin/mcp.js | tested with a script client only | |
| Skill package | 017 | .claude/skills/hatch | no | |
| systemd unit printer | 072 | bin/hatch.js | text only | untested in systemd |
| --view-only mirror and view token | 071 | src/server.js viewAllowed | yes | |
| --root file confinement | 009 (part) | src/files.js | tests only | |
| Review fixes (two rounds) | 041 052 | various | tests, browser regression | keep |

## Not done / known gaps

Security pass (009) is mostly open: widget files and /sdk.js are served without the token, `/proxy/PORT` reaches any local
port and proxied pages share Hatch's origin, run/term/exec commands are unrestricted. Never tried: a real phone, a real
OS clipboard, drag-drop of real files, Claude Code reading a pasted image, Claude building a widget from the snippet.

## Cut

Removed after the first review on 2026-11-08. They overlapped with something else, had no current use case,
or were unrelated to the main workflows. Old state files of these (`layouts/`, `recordings/`, theme blocks in `custom.css`,
saved macros in `commands.json`) are ignored without a warning. Macros and the hub are logged in `ideas.md` as possible future work.

| Feature | Ticket | What went |
|---|---|---|
| Saved layouts | 027 | `/api/layouts`, `hatch layout`, palette entries (workspaces and the leader key stay) |
| TODO list | 038 | `hatch todo`, `hatch_todo_add`, the TODO section of the session report (checkboxes in notes stay: they work in any note) |
| Palette timers | 078 | `timer` entries in the palette (`watch` and `every` stay) |
| Keyboard macros | 068 | recording and playback in `terminal.js`, palette entries, the `macro` flag of saved commands |
| Terminal recording and playback | 050 | `src/record.js`, the player panel, `hatch record|play`, `/api/record` |
| Tickets board widget | 012 | `examples/widgets/tickets` |
| System tray | 033 | the cpu/memory/load readout in the header and Settings and the server's `stats` events (the cpu, mem and load widget sources stay) |
| Colour themes | 055 | `src/themes.js`, `hatch theme`, the theme picker in Settings (one fixed default; it follows the system light/dark setting) |
| Hub for several boxes | 011 | `src/hub.js`, `hatch-server hub`, `hub add`, its page |
