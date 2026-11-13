---
name: hatch
description: Show things to the user in their browser on a box running Hatch (progress diagrams, images, live widgets, files, output windows, questions, notifications). Use when the user asks to "show me", "keep a live view", "ask me", "notify me", or when hatch is on PATH and a result is better seen than described.
---

This box runs Hatch. Drive the user's browser page with the `hatch` CLI. If it fails with "cannot reach Hatch", the server is not running: tell the user to run `hatch-server serve`.
When you test Hatch itself, use your own state dir and port (`--state DIR`, `--port N`), never the `HATCH_STATE` inherited from your terminal, and unset `HATCH_STATE` and `HATCH_URL` for test runs.

- Progress: `hatch progress plan "Inspect" "Build" "Verify"` creates the step journey. `hatch progress step "write tests" running|done|blocked --detail "Current finding"` updates a step; follow the granular workflow below. A Mermaid diagram via `hatch progress set diagram.mmd` is optional.
- Show: `hatch image PATH`, `hatch note "markdown"`, `hatch files DIR`, `hatch edit FILE`, `hatch open URL` (http://localhost:PORT is proxied to this box).
- Widgets: `hatch widget new NAME --from cpu|graph|clock|git|top|sysinfo|log-tail` (or no `--from` for a minimal template), edit the files under the state dir (widgets/NAME/), `hatch widget open NAME`. `hatch widget new --help` documents the postMessage SDK and data sources (metric, exec, tail, file). Editing a widget's files reloads it.
- Todos as a board: write a `PLAN.board.json` (version 1; cards `{id:"c1",x,y,w,h,text}`, `arrows:[]`, `view:{x:0,y:0,zoom:1}`, `nextId` above the highest id) whose card texts contain checklist lines `- [ ] item`, then `hatch widget open board ./PLAN.board.json`. The user ticks items by clicking (saved as `- [x]` in the file; re-read the file to see progress) and can add text or cards by hand. Write the file before opening; a change made while it is open is not reloaded.
- Output: `hatch run "npm test" --wait` (own window, returns the exit code), `hatch grep PATTERN [DIR]`, `hatch diff [git args]`; `path:line` results are clickable for the user.
- Talk to the user: `answer=$(hatch ask "Proceed?" Yes No)` (dialog, waits), `hatch notify "text" --level done|warn`, `hatch copy "text"` (their clipboard), `hatch watch idle 30` (ping when the terminal goes quiet).
- Pasted images arrive as files; the user types the path (under the state dir's uploads/).
- Everything is also plain files in the state dir (`.hatch/`): panels/*.json, progress/diagram.mmd, widgets/NAME/index.html.


## Granular progress workflow

When working in Hatch, maintain the plan throughout substantial tasks without waiting for reminders.
At the start, run `hatch progress plan "Inspect" "Implement" "Test"` with concrete task-specific steps.
Use `hatch progress show --json` to get their IDs. Mark the current step running before starting it,
then done only after verifying it: `hatch progress step ID running --detail "What I am doing now"`.
Update details at meaningful transitions (a discovery, completed change, test result, or blocker),
not on a timer. Split large tasks into smaller steps using `hatch progress steps set -` with a JSON array:
`[{"id":"inspect","title":"Inspect the layout","status":"running","group":"Discovery","detail":"Tracing popup focus"}]`.
Preserve existing work when adjusting the plan. Mark blocked steps with the reason and what is needed.
If several agents share this Hatch, give yours its own plan: `export HATCH_PLAN=my-task` (or `--plan my-task` on each `hatch progress` command). With two or more plans a command without a name fails and lists them.
Never guess progress percentages or mark work complete just because a command was started.
Steps are the primary visual; a Mermaid diagram is optional. `hatch progress open` opens details.
The user can also change a step's status in the browser; read the latest plan before replacing it.

Useful popup commands: `hatch image PATH`, `hatch open FILE|DIR|URL`, `hatch popup examples`,
`hatch popup open cpu`, `hatch popup generate "DESCRIPTION" --name NAME` (uses Claude Code),
`hatch panels`, `hatch minimize ID`, `hatch restore ID`, `hatch close ID`.

With MCP, use `hatch_progress_get`, `hatch_progress_plan`, and `hatch_progress_step` (with detail/group) for the same workflow. `hatch_progress_open` explicitly opens details; updates leave keyboard focus alone.
