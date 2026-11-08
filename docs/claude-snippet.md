This box runs Hatch. You can show things to the user in their browser with the `hatch` CLI:

- `hatch progress plan "Inspect" "Build" "Verify"` creates a visual plan; use concrete task-specific steps.
- `hatch progress step "write tests" running|done|blocked --detail "Current finding"` updates a step. See the granular workflow below.
- `hatch progress set diagram.mmd` optionally adds a Mermaid diagram alongside the step journey.
- `hatch image PATH` shows an image (screenshots, plots). Pasted images arrive as files; the user types the path.
- `hatch widget new NAME --from cpu|git|top|sysinfo|log-tail` scaffolds a live widget, `hatch widget open NAME` shows it. See `hatch widget new --help` for the postMessage SDK and data sources (metric, exec, tail, file). Editing the files reloads the widget.
- `hatch note "markdown"`, `hatch files DIR`, `hatch edit FILE` open a note, a file browser, a text editor.
- `hatch open FILE|DIR|URL` opens images, text files, directories or a dev-server iframe. A localhost URL is proxied to this box.
- `hatch run "npm test" --wait` runs a command in its own output window and returns its exit code.
- `hatch copy "text"` puts text on the user's browser clipboard.
- `hatch notify "text" --level done|warn` when you are blocked or finished.
- `answer=$(hatch ask "Proceed?" Yes No)` asks the user in a browser dialog and waits for the answer.
- `hatch every 5m "npm test"` re-runs a check in the background and tells the user when it goes red or green.
- `hatch watch idle 30` tells the user when the terminal goes quiet; `hatch cmd add NAME TEXT` saves a command for their palette.
If `hatch` fails with "cannot reach Hatch", the server is not running: tell the user to run `hatch-server serve`.


## Granular progress workflow

When working in Hatch, maintain the plan throughout substantial tasks without waiting for reminders.
At the start, run `hatch progress plan "Inspect" "Implement" "Test"` with concrete task-specific steps.
Use `hatch progress show --json` to get their IDs. Mark the current step running before starting it,
then done only after verifying it: `hatch progress step ID running --detail "What I am doing now"`.
Update details at meaningful transitions (a discovery, completed change, test result, or blocker),
not on a timer. Split large tasks into smaller steps using `hatch progress steps set -` with a JSON array:
`[{"id":"inspect","title":"Inspect the layout","status":"running","group":"Discovery","detail":"Tracing popup focus"}]`.
Preserve existing work when adjusting the plan. Mark blocked steps with the reason and what is needed.
Never guess progress percentages or mark work complete just because a command was started.
Steps are the primary visual; a Mermaid diagram is optional. `hatch progress open` opens details.
The user can also change a step's status in the browser; read the latest plan before replacing it.

Useful popup commands: `hatch image PATH`, `hatch open FILE|DIR|URL`, `hatch widget list`,
`hatch popup open cpu`, `hatch popup generate "DESCRIPTION" --name NAME` (uses Claude Code),
`hatch panels`, `hatch minimize ID`, `hatch restore ID`, `hatch close ID`.

With MCP, use `hatch_progress_get`, `hatch_progress_plan`, and `hatch_progress_step` (with detail/group) for the same workflow. `hatch_progress_open` explicitly opens details; updates leave keyboard focus alone.
