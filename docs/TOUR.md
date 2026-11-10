# A 15-minute tour

Use this to judge what is worth keeping (see `docs/FEATURES.md` for the full list). Start a server in a project directory
that is a git repo, open the printed URL, and open a terminal on the same box for the CLI (or use the page's own terminal:
`hatch` is on its PATH if you ran `./install.sh`).

1. **The terminal.** Type a few commands, reload the page: the screen and history are back. Ctrl+Shift+F finds text in
   the scrollback. Print `src/app.js:12` or a URL and click it.
2. **Paste a screenshot** anywhere on the page. The path is typed into the terminal. Tick "Show pasted images in a window" in the settings (off by default) to open it as an
   image window too, then click Annotate, circle something, Save and paste path.
3. **The palette** (the leader key Ctrl+Space, then p). Look at what it offers: it is the front door for most things below.
4. **The desktop.** `hatch desktop`, then palette > Tile floating windows. Drag, resize, minimise a few windows,
   double-click a title bar. Try Zen mode (Ctrl+Shift+Z).
5. **Progress.** `hatch progress set diagram.mmd` with a small flowchart, then `hatch progress step build running`.
   Drag the history slider after a second `progress set`.
6. **Output windows.** `hatch run "ls /nope; echo src/x.js:3 problem"`, click the reference. Then `hatch grep TODO .`
   and `hatch diff`.
7. **Git.** Change a file, `hatch git`, tick it, type a message, Commit.
8. **Files.** `hatch files .`, open a text file, edit, Ctrl+S.
9. **Talk to the user.** `answer=$(hatch ask "Ship it?" Yes No); echo $answer` and click a button. `hatch notify
   "done" --level done` with the tab in the background.
10. **Widgets.** `hatch widget new w --from graph`, `hatch widget open w`; edit `.hatch/widgets/w/index.html` and
    watch it reload. `hatch open http://localhost:PORT` for a dev server on the box.
11. **Workspaces.** Palette > Move window to workspace ..., then Ctrl+Shift+1 / 2.
12. **Look and feel.** Zen mode (Ctrl+Shift+Z), snap a window to a half from the
    palette, and watch the taskbar at the bottom. Put your own commands into the palette with `.hatch/custom.js`
    (`docs/CUSTOMIZE.md`).
13. **Keep an eye on things.** `hatch every 1m "npm test"` (notifies when it goes red or green), `hatch watch idle 30`,
    `hatch desktop` for the gadgets.
14. **Notes as runbooks.** `hatch note` with a fenced ```bash block: click Run; tick the checklist items; double-click to edit.
    Also bookmarks (`hatch bookmark add NAME`) and `hatch report --open`.

Then give Claude the snippet (`docs/claude-snippet.md`) or skill (`.claude/skills/hatch/`) and ask it to "show me live CPU
state" or "keep a progress diagram of this task": the real test of whether the CLI is easy enough for a model.

Things I could not check: a real phone, the OS clipboard, dropping real files, and Claude using any of this on its own.
