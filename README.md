# Hatch

> ⚠️ **Warning: this tool intentionally gives command-line access to the machine it runs on.**
> Anyone who can open the Hatch page gets a shell there, and widgets can run commands and read files by design.
> Run it only inside a VM, container or other isolated environment, never on your own host or a machine with data you care about.

A browser terminal for isolated boxes, grown into a small desktop. One server per box serves a page that is mostly a real
terminal attached to **tmux**, surrounded by windows and gadgets: paste or drop images and files into the box, a live
progress diagram that Claude updates, file browser and editor, output windows for commands, a git window, widgets
("show me live CPU state"), a command palette, notifications and more. Claude drives the page with a small CLI,
`hatch` (or the MCP server `hatch-mcp`). It is mostly a tool for my own use, shared as is.

Zero npm dependencies: Node 20+, python3 (standard library, for the pty), tmux, and vendored xterm.js and Mermaid.

**Precondition: you know tmux.** Hatch shows one tmux session in the page but provides no window navigation (no tab strip, no "new window" button). Create and switch tmux windows yourself with the prefix key and tmux commands (`new-window`, `select-window`, ...).

> **Security warning.** Hatch gives whoever has the URL a shell on the box, and widgets can run shell commands and
> read files. The token in the URL is a convenience against accidental access, not real security. Use it only on
> isolated machines on a network you trust, never on your own host or the internet. A full security pass is planned
> before V1.0 (widget isolation, auth, command and file access).

> Which features exist and how well each was checked: `docs/FEATURES.md`; a 15-minute guided try-out: `docs/TOUR.md`; the HTTP API: `docs/API.md`; when something is wrong: `docs/TROUBLESHOOTING.md`; customising: `docs/CUSTOMIZE.md`.

## Quick start

```
./install.sh                 # links hatch, hatch-server, hatch-mcp (and the deprecated hatch-ui) into ~/.local/bin
hatch-server start                  # one instance per user, state in ~/.hatch (created silently the first time); prints  http://<box-ip>:7070/?t=<token>
```

(`hatch-server serve` does the same in the foreground. 7070 taken: the next free port, saved in config.json.)

Open the URL in your browser. New projects receive a stable tmux session name derived from the project and state path (shown at startup); existing configured session names are retained. Closing the tab or restarting the server
does not end it. `hatch-server doctor` checks node, python3, tmux, the state dir and the server.

Background control: `hatch-server start`, `hatch-server stop`, `hatch-server restart`, `hatch-server status` (same options as `serve`; pid in `~/.hatch/hatch.pid`, output in `~/.hatch/log/daemon.log`). Lifecycle commands use the same state dir as everything else (`--state`, `HATCH_STATE`, `~/.hatch`; the current directory plays no role). Concurrent starts reuse one daemon. Startup options and the working directory are saved in `daemon.json` in the state dir; restart preserves them, with supplied flags overriding the matching saved flags. Restart after pulling changes in `src/`.

`hatch-server service` prints a systemd user unit for starting it at login or boot (it installs nothing).

Options: `hatch-server serve [--host H] [--port N] [--state DIR] [--session NAME] [--cwd DIR] [--root DIR] [--view-only] [--tmux-status] [--yes]` (`--tmux-status` mirrors the running progress step into the session's tmux status line).
The default host is `0.0.0.0` (reachable from your LAN) and the server prints who can reach it; use `--host 127.0.0.1`
to limit it. Requests with an unexpected `Host` header are refused (DNS rebinding guard): add names to
`HATCH_ALLOW_HOSTS`, `allowedHosts` in `config.json`, or one per line in `.hatch/allowed-hosts` (`hatch-server clear` keeps that file).

Sharing and limiting:
- `hatch-server url --view` prints a watch-only link for the same running instance (a second token that can only look;
  `hatch-server url --revoke-view` kills it). `--view-only` serves a whole instance as a read-only mirror: terminal output,
  windows and widgets can be watched; typing, files, runs and everything that changes state are refused. A viewer sees everything the terminal shows (including anything typed there) and widget data; give the link only to people you would let look over your shoulder. Existing output windows and additional terminals stream normally, and uploaded images remain visible. File browsers/editors, git and recording files show an availability message; their file APIs remain blocked. Write controls and command shortcuts are disabled for viewers.
- `--root DIR` confines file access (browser, editor, downloads, uploads, `/api/file`) to that directory, symlinks
  included; the terminal, `run`, `term` and widget `exec` commands are not confined.

The page itself carries a Content-Security-Policy (own scripts only, no inline script or eval), so `custom.js` must be a file, not an inline snippet, and cannot load code from other sites.

## Network and HTTPS tips

- On plain `http://` over a LAN address the browser is not in a "secure context": silent clipboard writes and desktop
  notifications may be blocked (Hatch falls back to a Copy button, toasts and a blinking title).
- A private overlay network (Tailscale and the like) can give you HTTPS and a stable name without exposing anything:
  for example `tailscale serve --bg 7070` publishes the port inside your tailnet over HTTPS. Add that host name to
  `allowedHosts` in `.hatch/config.json` (or `HATCH_ALLOW_HOSTS`) so the Host check lets it through, and start Hatch with
  `--host 127.0.0.1` so the plain port is not reachable from the LAN at all.
- Failed logins show up in `.hatch/log/server.log` as `auth failed: ...` (address, path; at most 10 a minute).
- Never put Hatch on the open internet: the token is a convenience, not real security (see the warning above).

## The state dir (`~/.hatch/`)

Files are the source of truth and the page is a live projection of them. Add `.hatch/` to your `.gitignore`
(Hatch also writes a `.gitignore` containing `*` into it). Editing files by hand works; malformed files show a
warning chip in the page and the last good state stays.

```
~/.hatch/config.json          token, port, session name
~/.hatch/uploads/17.png       pasted images
~/.hatch/panels/<id>.json     one open panel: {type,title,placement,x,y,w,h,props}
~/.hatch/progress/diagram.mmd the Mermaid source, steps.json the checklist, history/ older diagrams,
                              plans/NAME.json  named plans ({"diagram", "steps"}), one window each
~/.hatch/widgets/<name>/      index.html (+ assets) and widget.json
~/.hatch/commands.json        saved palette commands; watches.json output watches
~/.hatch/log/server.log
```

The running server re-checks `config.json` every few seconds and restores its own `port` and `host` if something else overwrote them (other keys are never touched; see `docs/TROUBLESHOOTING.md`).

Everything the CLI does is also possible by writing these files directly or by calling the HTTP API with the token
(header `x-token`).

**One instance per user.** The state dir, for the server and for every client (`hatch`, `hatch-mcp`, `hatch-server url|doctor|...`), is `--state DIR`, else `HATCH_STATE`, else `~/.hatch`. Nothing else is consulted: not the current directory, and no `.hatch` of a parent or project is ever picked up. Projects are workspaces inside that one instance (one URL, one token, one port 7070); a second, separate instance needs its own `--state DIR` and `--port N`. A plain `hatch-server serve|start` creates `~/.hatch` silently the first time. An explicit `--state DIR` or `HATCH_STATE` that points at a missing or invalid dir is confirmed first (`--yes` creates it without asking; without a terminal to ask on it fails instead, so background and service setups pass `--yes` or an existing dir). When a `./.hatch` exists in the directory you start the server from, it prints one line saying it is ignored and pointing to `hatch migrate`. If a server cannot be reached, the error names the `config.json` the port came from and what to do next.

**The workspace of a command.** `hatch` commands that open windows put them into `--ws NAME`, else `$HATCH_WORKSPACE`, else `main`. Hatch exports `HATCH_WORKSPACE` (with `HATCH_URL` and `HATCH_STATE`) in every workspace's terminals, so Claude running in a workspace's terminal opens its windows there; `hatch-mcp` does the same. Windows moved to another workspace update the variable for new tmux windows only: a shell that is already running keeps the value it started with (open a new tmux window, or pass `--ws`). `main` terminals export `HATCH_WORKSPACE=main`. A workspace can start its terminals in a directory (`cwd` in `workspaces.json`; `hatch migrate` sets it); a terminal window can carry its own `props.cwd`.

Environment variables `HATCH_URL`, `HATCH_STATE` and `HATCH_WORKSPACE` are set for the tmux
session; windows that already exist only get them in new windows.

## Upgrading to the per-user instance

Older versions kept one `.hatch/` per project (own token, port, windows). Now there is one instance per user in `~/.hatch`, and each project becomes a workspace in it. Your project `.hatch` is never modified or deleted by this.

```
hatch migrate --dry-run             # in the project (or: hatch migrate PROJECT-DIR): prints exactly what would be imported, changes nothing
hatch-server stop --state .hatch    # 1. stop the old instance (in the project; or Ctrl+C where it runs). Migrate never stops or starts anything
hatch migrate                       # 2. import it (asks before creating ~/.hatch; --yes skips the question; --name NAME names the workspace)
hatch-server start                  # 3. start the per-user instance, then open the URL it prints (new token)
```

`hatch migrate [DIR]` takes `DIR/.hatch` (or a path that is itself a state dir; without DIR the nearest `.hatch` above the current directory, for this command only). It creates a workspace named after the project folder (`--name` overrides; a name that already exists is an error and changes nothing; the source's own workspaces become `NAME-WORKSPACE`) and carries over: windows and layout, the background, the start directory of its terminals, saved commands and prompts, widgets, schedules, bookmarks, custom CSS/JS, fx/transparency/size settings, `allowedHosts`, and other `config.json` settings. It merges files and never overwrites: whatever the target already has wins and every difference is listed as a conflict (a differing `custom.js`/`custom.css` is saved next to the target's as `custom.js.NAME.migrated` for a hand merge). Token, port and tmux session name belong to the target and are not carried over; progress plans, run history and trash are not imported. It works on files, so it works with the target stopped or running (a running server notices the new files by itself). A terminal window or workspace terminal starts a fresh shell in the old directory: the old tmux sessions are not attached, so anything running in them has to be recreated by hand (they keep running until you kill them). With `--state TARGET` it imports into another state dir instead of `~/.hatch`.

Going back: the project `.hatch` is as it was. Stop the per-user instance and start the old one from the project with `hatch-server start --state .hatch --yes` (and `HATCH_STATE=.hatch` for the CLI). `~/.hatch` can be deleted to undo the import.

## What you can do

- **Terminal.** tmux in the page. Reload re-attaches; if the pty dies the page reconnects with backoff. Input queued for an old connection is discarded during reconnect so commands are not replayed accidentally. Select with
  Shift+drag and copy with Ctrl+C (without a selection Ctrl+C interrupts). The leader key (Ctrl+Space, then t) returns focus to the
  terminal. Ctrl+Shift+Space does it in one chord from anywhere, widget frames and the palette included. Ctrl+B with a window focused (not a text field) returns to the terminal and sends the tmux prefix. Ctrl+Shift+F searches the scrollback (Enter next, Shift+Enter previous, Esc closes). Mouse mode, `allow-passthrough` and the tmux prefix are your own tmux config; Hatch never touches `~/.tmux.conf`.
- **Image paste and drop.** Paste a screenshot (or drop an image) anywhere on the page: it is saved to
  `uploads/N.ext` on the box, the absolute path is typed into the terminal (as a bracketed paste when the program asks
  for it, as Claude Code does). An image window only opens if you tick "Show pasted images in a window" in the settings (off by default). Claude Code can then read the file. No resizing happens.
- **Any file.** Dropping or pasting a non-image file on the page saves it into `uploads/` under its own name (numbered if taken) and types its path; file rows in the files window can be dragged into the terminal to type their path.
- **Image inspection.** Images fit the popup and show their dimensions and zoom. Click the image (once its window is focused; the first click only focuses) or the zoom button for fit/actual size, use the wheel or +/− to zoom, 0 to fit and 1 for actual size. Enlarged images remain scrollable. “Use path” pastes the quoted path back into the terminal. SVG display is supported alongside PNG, JPEG, GIF and WebP.
- **Annotate.** An image window's Actions → Annotate command draws a pen, boxes and arrows (four colours, Undo) over the image; Save and paste path stores a marked-up PNG as a new upload and types its path. Failed saves keep the marks so you can retry; closing unsaved annotations asks before discarding them.
- **Windows.** Panels float over the terminal (drag, resize by the corner grip or the right and bottom edges, minimize, close) or dock in the right column. Drag a docked window by its title bar to reorder the dock (a line shows where it will land, Escape cancels); the order is saved and shared with other open tabs. Changing a window's type (note, widget, progress) has no title-bar button: use `hatch convert NAME --to TYPE` or `POST /api/panels/:id/convert`. The leader key then Shift+`d` is "show desktop": it minimizes every floating window; pressing it again before anything changed (no window opened, closed, moved, resized or restored in between) brings them all back as they were, the most recently focused one on top. After a change the second press just minimizes whatever is showing. Geometry is
  saved into the panel file.
- **Progress.** The terminal fills the workspace. The Progress button or Ctrl+Shift+G unfolds a slim strip showing the current step and a segmented overview; click it for a connected step journey with expandable details, groups, update times and manual status controls. `hatch progress plan "Inspect" "Build" "Verify"` creates a plan; `hatch progress show --json` lists IDs; `hatch progress step ID running --detail "Checking popup focus" --group Verification` updates a step. `hatch progress open` opens details. Progress data updates leave keyboard focus and popup visibility alone; open details explicitly when wanted. Mermaid diagrams and their history remain available under “Diagram & history”; they are optional.
- **Background effects.** `hatch fx matrix`, `hatch fx rain` or `hatch fx goo` animates the area behind the terminal text (visible at any transparency; `--intensity 0-100` sets how strong, per effect); `hatch fx off` stops it. See `docs/CUSTOMIZE.md`.
- **Several plans.** Parallel work (two agents in one instance) can keep one plan each: `--plan NAME` on any `hatch progress` command, or `export HATCH_PLAN=NAME` in a terminal, picks the plan; it is created on first use and gets its own progress window titled with the name. `hatch progress plans` lists them, `hatch progress close --plan NAME` removes one. With zero or one plan nothing changes (no name needed); with two or more and no name the command fails and lists the plans instead of guessing. The MCP progress tools take the same `plan` argument (or read `HATCH_PLAN`). Named plans have no diagram history; the plan name `default` means the classic unnamed plan.
- **Command palette.** Ctrl+P (also Ctrl+Shift+P in Chrome, which Firefox reserves for a private window), or the leader key then p (or the Commands button), opens a searchable list (the entries you use most come first; type `!ls -la` to run a shell command in an output window, `/name` to open a file of the project in the editor, `@name` to type an `@path` mention for Claude Code, `=2*(3+4)` to calculate): open widgets and notes, minimize or close windows, terminal font size, and your saved commands (`hatch cmd add tests "npm test"`; they are typed into the terminal).
- **Prompts, Zen, chords.** `hatch prompt add review -` (text on stdin) saves a multi-line prompt that the palette pastes without pressing Enter; Ctrl+Shift+Z toggles Zen mode; Ctrl+Shift+1..9 switch workspaces.
- **Schedules.** `hatch every 5m "npm test"` runs a command periodically and notifies you when it starts failing or recovers (`--always` after every run); `hatch schedules`, `hatch unschedule NAME`. Stored in `schedules.json`. A schedule waits for its previous run to finish; removing it prevents future runs and completion alerts while the current command remains listed and can be stopped.
- **Bookmarks.** `hatch bookmark add NAME [PATH]` (also in the palette) saves a file or folder; `Bookmark: NAME` in the palette opens it.
- **Recent files and clipboard history.** The palette also has Open file by path..., Recent file: ... and Paste from history: ... (the last copies from the terminal selection or the clipboard bridge), kept per browser.
- **Host a page.** `hatch host FILE.html` prints a URL (with your Hatch token) that opens the page full size in a normal browser tab; the file's folder is served read-only so its CSS, scripts and images load. Dotfiles, `..` paths and symlinks that lead outside the folder give 404, and a watch-only (view) link can read hosted pages but not create them. The page runs in Hatch's own origin, so host only files you trust, and treat the link like your main URL. Hosting is forgotten when the server restarts (run the command again).
- **Files and editor.** `hatch files [DIR]` (or the palette) opens a file browser window: click a folder to enter it, an image to view it, a text file to edit it (Ctrl+S saves; Reload asks before discarding unsaved changes; a stale save is refused; a window without unsaved edits reloads when the file changes on disk), `↓` downloads, `⌨` types the path into the terminal, and dropping files onto the window uploads them into the shown folder. `+ file`, `+ folder`, `✎` (rename or move) and `🗑` (delete, click twice) manage files; deletes are permanent. Markdown, JSON and CSV/TSV files have a Preview button (rendered text, pretty JSON, a table). `hatch edit FILE[:LINE]` opens the editor directly; `hatch-server serve-dir DIR` serves a folder (a coverage report, say) and shows it in a window. No path sandbox yet (see the security ticket).
- **Asking you.** `answer=$(hatch ask "Deploy?" Yes No)` shows a dialog in the page and waits; `--text` gives a text box, `--timeout SEC` gives up with exit code 3. Open questions survive a page reload but not a server restart. The first accepted answer wins across tabs; typed text survives connection reconnects, and pending submissions disable duplicate answers. Timeouts must be positive finite seconds.
- **Home screen.** The page has a web app manifest and icon, so "Add to Home screen" on a phone opens it full-screen like an app (no offline mode).
- **Phone.** Under 700 px wide the page stacks and windows go full width; on touch devices (or Settings) an extra keys bar offers Esc, Tab, a sticky Ctrl, arrows, Home/End, PgUp/PgDn and `| ~ / -`.
- **Desktop.** `hatch desktop` (or the palette) opens a set of live gadgets: CPU/memory graph, system, clock, top (an interactive terminal running `htop`, or `top` if htop is missing), git and log tail, plus the progress panel. Use Tile floating windows to refit them to your screen.
- **HTML pages.** `hatch open FILE.html` (or `.htm`) renders the page in a window instead of opening an editor; `hatch edit FILE.html` or the window's Edit source button opens the source. See "HTML page windows: how safe is this?" below.
- **Output windows.** `hatch run "npm test"` runs a command in its own window with live output, exit status, Stop, Rerun, Copy and a line filter. `path:line` references open the file in an editor window; `--wait` blocks and returns the exact command exit code, including failures and signal exits. Stop allows two seconds for cleanup, then kills the process group if needed. A finished run notifies you. Long-running output keeps a bounded tail in the browser and shows a notice when earlier text is discarded; Copy copies the retained output.
- **Terminal links.** `path:line` references and URLs in the output are clickable: a file opens in an editor window on that line (relative paths are tried against the server dir and the tmux pane's directory), a URL opens in a new tab. References broken across a wrapped line are not joined.
- **Runnable notes.** Shell code blocks (```bash, ```sh, ```shell, ```zsh, ```console) in a note get a Run button that executes the block in an output window, so a note can be a runbook; nothing runs without a click.
- **Clipboard bridge.** `hatch copy "text"` (or `cmd | hatch copy -`) and terminal OSC 52 sequences (tmux and vim/neovim yanks over ssh; Hatch sets tmux's `set-clipboard on` at runtime for its tmux server, your `~/.tmux.conf` is untouched) put text on your browser's clipboard. If the browser refuses a silent write, a toast with a Copy button appears.
- **Git widget.** `hatch widget open git` opens a read-only status widget (head with ahead/behind, unstaged/staged/untracked sections that fold on click, the 5 most recent commits: subject, refs other than the checked-out branch, age, an author initial only when authors differ, a marker for unpushed commits, and the hash on hover) for the repository of the shell's current directory. Each project gets its own widget `git-<folder>` titled `Git: <folder>`; opening it again from the same directory reuses it. Click a commit (or a recent-activity entry) to inspect it in place of the list: header (hash, author, date, refs, parents you can click through), a `--stat` style summary with +/- counts and proportional bars, then the full patch per file with added/removed lines coloured and hunk headers dimmed; files fold, long patches show 400 lines and a "show more", and a patch over 40 KB is cut with a per-file load link. Click a changed, staged, conflicted or untracked file to see its diff (renames, deleted and binary files are handled; an untracked folder lists its files). Back or Escape returns to the list, and a file's diff follows the working tree. The view is inside the widget, not a separate window (a widget cannot open windows). Section headers still fold on click. It refreshes every 3 s using `git --no-optional-locks`, so it never takes the index lock. Opened from the palette it shows the server's directory. `hatch-server update-widgets git` (or `--all`) refreshes every `git-<folder>` copy to the shipped code, keeping its project directory, title and window size; `hatch-server update-widgets git-<folder>` does one.
- **Git window.** `hatch git [DIR]` shows branch and changes with stage checkboxes, a commit box, and a diff window per file (stage, unstage, commit only; no push, pull or discard).
- **Search and review.** `hatch grep PATTERN [DIR]` and `hatch diff [git args]` open output windows: results are `path:line` links that open the editor on that line, diffs are coloured.
- **man, tail, log, curl.** `hatch man PAGE`, `hatch tail FILE`, `hatch log [git args]` and `hatch curl [curl args] URL` open output windows (tail follows until you press Stop).
- **Terminal windows.** `hatch term build --cmd "npm run watch"` opens another terminal in a floating window, on its own tmux session named after the main session plus `-build`. Closing the window leaves the session running (`DELETE /api/pterm/build` ends it, or kill that session with tmux).
- **Window transparency.** Windows are opaque by default (0), independent of the terminal transparency (`hatch set transparency N`, default 30), unless you set one with leader `o`. `hatch set window-transparency N|default|follow` (or the palette entry "Windows: set default transparency...") changes the default of every window without its own setting: a number 0-100, `default` (back to 0), or `follow` (windows follow the terminal transparency, as older versions did). Upgrading: a state without the `windows` field now gets opaque windows; run `hatch set window-transparency follow` for the old look. `hatch windows transparency N` (or "Windows: set transparency of all open windows..." in the palette) sets every window that is open right now at once. See `docs/CUSTOMIZE.md`.
- **Background image.** `hatch set background IMAGE` stores the image in the state dir and shows it behind the page (see `docs/CUSTOMIZE.md`).
- **Customising.** `.hatch/custom.css` and `.hatch/custom.js` are loaded when present; `window.hatchUI` lets `custom.js` add palette commands and react to events (`docs/CUSTOMIZE.md`).
- **Taskbar and snapping.** The chips in the header list every window of the current workspace; click one to bring it to the front (or restore it). The palette snaps a window to the left or right half or makes it fill the terminal area.
- **Workspaces.** One Hatch instance holds several named workspaces; each has its own windows and layout, its own main terminal (a tmux session) and its own background. Server config, settings and the palette are shared. Switching only changes what is shown: terminals keep running, and a workspace that rang a bell or printed a burst while you were away gets a dot in the header. The header chips switch, `+` adds one; palette: `workspace: switch | new | rename | close | set background...` and `window: move to workspace...` (the terminal stays alive). Closing asks you to type the exact workspace name, then ends its windows and tmux sessions. Leader then `]` / `[` is next / previous workspace, leader then `w` and a digit jumps by number (Ctrl+Shift+1..9 also works). The URL follows the workspace (`/#work`; back, forward and bookmarks work; an unknown name offers to create it; a bare URL opens the last used one). The same workspace may be open in two tabs (both stay live and show an "also open in another tab" notice). From the CLI: `hatch workspace list|new|rename|close NAME --confirm NAME|import STATE-DIR [NAME]`, `hatch migrate [DIR]` (a whole project `.hatch`, see Upgrading), `hatch set background IMAGE --ws NAME`, and `--ws NAME` on any command that opens a window (default `$HATCH_WORKSPACE`, else `main`). On the first start after upgrading, the existing windows and background become workspace `main` and the previous state is copied to `backup-pre-workspaces/` in the state dir (delete it when you are happy). `Pin to all workspaces` (palette) keeps a window visible everywhere; leader Tab cycles through windows. Leader then Shift+d docks the focused floating window or releases a docked one.
- **Setup transfer.** `hatch export` bundles your saved commands, prompts, watches, schedules, bookmarks, `custom.css/js` and widgets (never the token or uploads); `hatch import FILE.tgz` restores them on another box.
- **Trash.** Closing a window moves its file to `.hatch/trash/<time>-<id>.json` (kept: last 30, at most 14 days). `hatch trash`, `trash restore [ID]`, `trash empty`, or the palette ("Reopen closed window"). Terminal windows keep name, command and position, not scrollback: restoring reattaches the tmux session of that name if it is still alive, else starts a fresh one.
- **Watches.** `hatch watch add failed --pattern "FAIL|Error" --level warn` and `hatch watch idle 30` notify you when terminal output matches or goes quiet for 30 s (stored in `watches.json`, 30 s cooldown per watch). Overlapping watches match independently; UTF-8 text and terminal escapes may span output chunks. Invalid hand edits show a warning while the last valid watches stay active.
- **Tasks and ports.** The palette lists `Task: npm run ...` / `make ...` from the server directory and `Open port N in a window` for every listening TCP port (shown through the proxy). CLI: `hatch tasks [--run NAME]`, `hatch ports`.
- **Session report.** `hatch report [--open] [--out FILE]` summarises progress, runs and open windows as markdown.
- **Server log.** Palette > Show server log follows `.hatch/log/server.log`; the page also reports its own JavaScript errors there (`client error: ...`), which helps when something misbehaves in your real browser.
- **Notification log.** Palette > Show notification log lists the last 100 notifications this browser received.
- **Notifications.** `hatch notify "waiting for you" --level warn` gives a toast, a blinking title when the tab is
  hidden and a desktop notification if you enabled them in Settings (plain http on a LAN address may block those).

## Terminal commands and shortcuts

Use `hatch` for everyday interaction with the page. `hatch-ui` still works as a deprecated alias, and `hatch serve|start|stop|restart|status|url|service` still forward to `hatch-server` with a notice. Page commands also accept global options before the command, such as `hatch --state DIR open FILE`. `hatch popup`, `hatch progress --help`, and `hatch image --help` provide focused usage guides:

```sh
hatch image screenshot.png --size 800x550
hatch open README.md                 # images, text files, HTML pages, directories or http(s) URLs
hatch widget examples              # bundled example widgets (hatch widget open NAME installs and opens one)
hatch popup open progress
hatch popup create my-clock --from clock
hatch popup open cpu
hatch popup generate "a small clock" --name my-clock  # requires Claude Code
hatch progress plan "Inspect" "Build" "Verify"
hatch progress step Inspect running --detail "Reading the current layout"
hatch progress open
hatch popup list
hatch panels
hatch minimize PANEL_ID
hatch restore PANEL_ID
hatch close PANEL_ID
```

Opening commands accept `--size WIDTHxHEIGHT`, `--full` (or `--fullscreen`), and `--no-focus`. Text files (`hatch open`, `hatch edit`, the file browser, the palette) open in vim in a terminal window when vim is installed; set `"editor": "builtin"` in the same file for the textarea editor, or a command name such as `"nvim"`. In a file browser window, click it or press a key to focus it: `j`/`k` move, `h` goes up, `l` opens. Set `"imageSize": "800x550"` in `.hatch/config.json` for a default image window size; explicit `--size` wins. Reopening a widget or progress window restores it and brings it forward. Double-click a popup title bar to maximize or restore it; that state survives reloads.

The header keeps secondary tools in the command palette. It opens immediately with primary actions while additional commands load; Escape returns to the previous focus. Search “Switch to popup” to restore a particular window. Progress and the dock start folded; their visibility is remembered per browser. Popups take focus when opened or restored. Minimized popups stay in the bottom taskbar. Minimize/restore responds immediately while saving state. Docking preserves editor buffers, and closing an editor with unsaved work asks before discarding it.

| Shortcut | Action |
|---|---|
| Ctrl+P, or Leader (Ctrl+Space) then p | Command palette (Ctrl+P also works with the terminal focused; Ctrl+Shift+P too, except in Firefox) |
| Leader, then t | Return to terminal |
| Leader, then h / j / k / l | Focus the nearest window or the terminal to the left / below / above / right |
| Leader, then Shift+h / j / k / l | Move the focused floating window by 40px (stays on screen, position is saved) |
| Leader, then d | Dock the focused floating window, or release a docked one (same as the title-bar button) |
| Leader, then s | Show or hide the dock column (also palette: Toggle dock; Zen mode hides it too and restores it as it was) |
| Leader, then m / q / u | Minimize, close, restore from the dock |
| Leader, then Tab | Next window |
| Ctrl+Shift+G | Fold or unfold progress strip |
| Ctrl+Shift+F / Z / 1..9 | Terminal find / Zen mode / workspaces |

For agents, run `hatch agent init` once in your project. This adds a managed Hatch block to `CLAUDE.md` and `AGENTS.md`, preserving the project's other rules; rerunning updates only that block. Use `--target claude` or `--target codex` to configure one, and `--dir DIR` to choose the project. It works before the server starts. `hatch agent show` prints the instructions for manual setup, or you can install the supplied Hatch skill. The instructions ask the agent to maintain small steps and update details at meaningful transitions without repeated reminders. Hatch does not infer task completion from terminal output; the agent must report it. State lives in the per-user instance (`~/.hatch`); the project is a workspace. Keyboard shortcuts work inside widgets that load `/sdk.js`; an external website embedded in a popup can capture its own keyboard events.

## hatch

```
hatch progress set FILE|-          hatch progress step "TITLE|ID" todo|running|done|blocked|skipped
hatch progress show | steps set FILE|-
hatch widget new NAME [--from cpu|graph|clock|git|top|sysinfo|log-tail|matrix|analog-clock|ascii-donut|quote] | add NAME [DIR|FILE] | open | close | rm | reload | list
hatch files [DIR] | edit FILE | image PATH | open URL | note "markdown" | panels | close ID | notify "text" [--level info|warn|done]
hatch cmd add NAME TEXT | cmd list | cmd rm NAME   (saved commands for the palette)
hatch prompt add NAME TEXT|- | prompt list | prompt rm NAME
hatch set background IMAGE | set transparency 0..100 | set window-transparency 0..100|default|follow | windows transparency 0..100
hatch git [DIR] | grep PATTERN [DIR] | diff [GIT-ARGS] | log [GIT-ARGS] | man PAGE | tail FILE | term NAME [--cmd CMD] | run "CMD" [--wait] | desktop
hatch ask "question" [CHOICE ...] [--text] [--timeout SEC]
hatch copy TEXT|-
hatch every INTERVAL "CMD" | schedules | unschedule NAME
hatch bookmark add NAME [PATH] | list | rm NAME
hatch watch add NAME --pattern RE | watch idle SEC | watch list | watch rm NAME
hatch export [FILE] | import FILE [--force]
hatch upload-dir | doctor           (exit codes: 0 ok, 1 usage, 2 server unreachable)
```

**MCP.** `claude mcp add hatch -- hatch-mcp` (after `./install.sh`; or `node /path/to/hatch/bin/mcp.js`) gives Claude the same actions as typed tools (`hatch_progress_get`, `hatch_progress_plan`, `hatch_progress_open`, `hatch_progress_set`, `hatch_progress_step`, `hatch_note`, `hatch_image`, `hatch_notify`, `hatch_ask`, `hatch_run`, `hatch_open_widget`, `hatch_copy`, `hatch_report`; `hatch_run` with `wait` returns the output tail too). It uses `HATCH_STATE`, else `~/.hatch`.

Teach Claude about it by pasting `docs/claude-snippet.md` into your project's `CLAUDE.md`, or copy `.claude/skills/hatch/` into your project (or `~/.claude/skills/`) so it loads on demand.
`hatch open http://localhost:3000` shows a dev server running on the box: the URL is rewritten to `/proxy/3000/`, which Hatch forwards to the box's own port (HTTP and WebSocket). Root-absolute links in HTML are rewritten; URLs built in JavaScript are not, so some single-page apps need `--direct` and a reachable address instead.

## Widgets

A widget is `widgets/NAME/index.html` plus an optional `widget.json`, shown in a sandboxed iframe
(`sandbox="allow-scripts"`: opaque origin, no cookies, no network). Data arrives by postMessage; `/sdk.js` wraps it:

```json
{ "title": "CPU", "w": 320, "h": 200, "placement": "float",
  "sources": [ { "name": "cpu", "kind": "metric", "id": "cpu", "everyMs": 1000 } ] }
```
```html
<script src="/sdk.js"></script>
<script>hatch.on('cpu', (v) => { el.textContent = v.total + '%'; });</script>
```

Protocol. Page to widget: `{type:'init', name, theme:{bg,fg,accent,mono}, sources:[names]}` once loaded, then
`{type:'data', source, value, ts}` per sample. Widget to page: `{type:'subscribe'|'unsubscribe', source}`,
`{type:'call', id, source, arg?}` (answered by `{type:'result', id, value|error}`), `{type:'resize', w, h}`, `{type:'log', text}`.
SDK: `hatch.on(source, fn)`, `hatch.off`, `hatch.call(source, arg?)` (a promise, see below), `hatch.resize`, `hatch.log`,
`hatch.theme`, `hatch.ready(fn)`.

Sources (declared in `widget.json`, run on the server, shared between widgets, stopped when nobody listens):

| kind | fields | value |
|---|---|---|
| `metric` | `id`: `cpu`, `mem`, `load`, `disk` (`path`), `net`, `ports` | `{total,cores}`, `{total,used,available,pct,...}`, `{l1,l5,l15}`, `{path,total,used,pct}`, `{rxBps,txBps,rx,tx}`, `{ports:[{port,process,scope}]}` |
| `exec` | `cmd` (may use `{{widget}}`, `{{session}}`, `{{state}}`, `{{cwd}}`), `everyMs` (min 500), `json`, `timeoutMs` | `{out, code, json?, error?}`. **Runs an arbitrary shell command.** Output capped at 64 KB, one run at a time |
| `tail` | `path` | `{lines, append}`: the last 200 lines first, then new lines |
| `file` | `path` | `{text}` whenever the file changes |

**Calling a source with an argument.** `hatch.call('del', 'photo.jpg').then((value) => ...)` runs an `exec` source once (it is not
subscribed and not polled) and resolves with the same `{out, code, json?, error?}` value. The argument reaches the command as the
environment variable `$HATCH_ARG`, never inside the shell text, and must look like a file name (letters, digits, `_ . - ` and spaces,
starting with a letter or digit, at most 200 characters), so a command can use `"$D/$HATCH_ARG"` without path tricks or injection.
A source that declares `"arg": "any"` accepts any text up to 4000 characters without control characters other than tab (the git widget passes paths and refs this way, so such a command must treat `$HATCH_ARG` as data: quote it, put it after `--`). Calls need the full link (a watch-only link gets 403) and at most 4 run at once. `{{widget}}` in a command is the widget's folder
name, so a widget does not hardcode where it lives.

A widget can keep what it writes at run time (downloads, saved items) in `widgets/NAME/data/` and serve it at `/widgets/NAME/data/...`;
changes in that top-level folder do not reload the widget, while changes anywhere else in the widget directory do.
`timer` and `pomodoro` use this to survive a reload: their state is the name of an empty file in `data/` (see the comment at the top of each `index.html`), written through exec sources and `hatch.call`, because a widget iframe has no storage of its own.

Editing any file in the widget directory (except `data/`) reloads it in the page. Examples live in `examples/widgets/` (`scratchpad`, `background-roulette`, `cpu`, `graph`, `clock`, `log-tail`, `git`, `top`, `sysinfo`, `ports`, `pomodoro`, `timer`, `docker`). `background-roulette` downloads random photos from picsum.photos when you click its button (the box needs internet access; nothing is fetched otherwise), keeps them with their source information in its `data/` folder, and sets the one you click as the page background through `hatch set background`, so `hatch` must be on the server's PATH. `scratchpad` is a PROTOTYPE visual scratchpad (something between a note app and a diagram tool): double-click the canvas for a text card, drag a card by its top bar, drag its right-hand dot onto another card for an arrow, click a card or arrow and press Delete (or use the card's x), drag the background to pan, scroll to zoom. The board (cards, arrows, pan and zoom) is saved as `data/board.json` in the widget folder and restored on open; a hand-edited or broken file gives an empty or repaired board, never an error. Known gaps: plain text only, one board per widget copy, no undo, no multi-select, no touch, arrows are straight lines, a board over about 60 KB cannot be read back, and it has only been looked at in headless Chromium. Notes are editable: double-click a note window, Ctrl+Enter or Save saves, and Escape or Cancel discards the draft. Clicking outside also saves. Failed or conflicting saves keep the draft editable; closing asks before discarding unsaved text.

Opening an example copies it into the state dir once; after upgrading Hatch an instance keeps its old copy. `hatch-server update-widgets NAME...` (or `--all`) refreshes the widgets that instance already uses from the shipped copies. It works while the server runs, never touches a widget's `data/` folder, and saves any locally changed file as `<file>.bak` first. Hatch remembers which shipped version an example was copied from (`shipped-widgets.json` in the state dir); when the shipped copy has changed since, `hatch widget open NAME` and the palette's example entry say so and name the command. Copies made before this was recorded are flagged only when their files look untouched; nothing is said when it cannot tell.

## HTML page windows: how safe is this?

`hatch open FILE.html` shows the file in an iframe with `sandbox="allow-scripts allow-forms allow-popups"`, the same opaque-origin isolation widgets use, and the server repeats it as a `Content-Security-Policy: sandbox ...` header on every file it serves, so the page stays isolated even if its URL is opened directly in a tab.

What the page can do: run JavaScript, load the files next to it (the whole folder of the file, including sub folders), submit forms and open popups (which stay sandboxed), and make network requests like any web page (external CDNs work; so can requests to other ports the browser can reach, e.g. other local dev servers, and fetches of its own files since the server answers them with CORS open).

What it cannot do: read Hatch's cookie or token (no `allow-same-origin`), call the Hatch API or touch the Hatch page (`parent.document` is blocked), navigate the Hatch page, or read files outside the file's folder. `..`, symlinks that lead out of the folder, and hidden files or folders (`.git`, `.env`) are refused with 404.

How it is authorised: files are served at `/page/KEY/...` without the token (a sandboxed frame cannot send the cookie). KEY is a random 128-bit id made by the server when the window opens and kept in the window's panel file; closing the window revokes it, and the key is not part of any file the page can see except its own URL. Anyone who can see the panel list (including a view-only link) can see the key, and so can read that folder. With `--root DIR`, the folder must be inside DIR.

What to keep in mind: the page is code you chose to run in your browser, with the usual web-page powers. Do not open pages you do not trust from a folder that contains secrets (everything not hidden in that folder, sub folders included, is readable by the page), and prefer a folder of its own. Checked in Chromium only.

## Tests

`node --test "test/*.test.js"` starts real servers on ephemeral ports with `cat` instead of tmux; one test uses real
tmux when it is installed. Browser-only behaviour (paste, drag, windows, Mermaid rendering) is checked by hand; see the
"To test" steps in each ticket.

## Notes and limits

- One pty serves all browsers; its size follows the most recent resize.
- Plain http is not a secure context: no `navigator.clipboard.read` (paste uses the paste event, copy has a textarea fallback), notifications may be blocked.
- If the screen looks garbled after a reconnect, `tmux refresh-client` (or Ctrl+B r with a binding) repaints it.
- Widget files and `/sdk.js` are served without the token (a sandboxed iframe cannot send the cookie). They contain only what was written into the widget dir. HTML page windows are served the same way under a per-window random key (see above).

## License

MIT, see `LICENSE`.
