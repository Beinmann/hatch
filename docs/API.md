# HTTP API

Everything the page and `hatch` do goes through this API, so scripts and Claude can call it directly.
Authenticate with the token from `.hatch/config.json`: header `x-token: TOKEN` (the page uses a cookie). JSON in, JSON out
unless noted. Errors are `{ "error": "message" }` with a meaningful status (400 bad input, 401 token, 403 Host or --root,
404, 409 conflict, 413/415 size/type, 502 proxy). Source of truth: `src/server.js`; tests show every route in use.

## Events (server to page)

`GET /api/events?cid=ID` is one SSE stream. First event `snapshot` (`panels`, `progress`, `widgets`, `warnings`, `asks`,
`info`), then `panel` (`created|updated|removed`), `progress`, `widget`, `warning`, `notify`, `ask`, `ask-done`, `copy`,
`source` (widget data). `POST /api/sub {cid, widget, source, on?}` subscribes a widget source to that stream.
`POST /api/call {widget, source, arg?}` runs an `exec` source once and answers `{value}` (same shape as a subscription value); `arg` becomes `$HATCH_ARG` and must be a file-name-like word (400 otherwise). Full token only, at most 4 at a time (429).

Event, terminal and run connections use the same bounded delivery: a backpressured connection queues at most 2 MiB of follow-up events. Overflow or thirty seconds without
a drain closes that stream; the browser reconnects and receives a fresh snapshot. Healthy connections continue
independently. Terminal and run streams also retry after one second; completed runs replay their retained tail
and exit status, and queued output drains before a normal exit event closes the response. This is live state delivery, so clients should reconstruct state from each new snapshot.

## Terminal

`GET /api/term` (ensure session and pty), `GET /api/term/stream` (SSE, base64 chunks, one `replay` event first),
`POST /api/term/input {data}`, `POST /api/term/resize {cols, rows}`.
Terminal windows: `POST /api/pterm/NAME {cmd?}` (create or attach), `GET .../stream`, `POST .../input|resize`, `DELETE /api/pterm/NAME` (kills the tmux session).

## Panels, widgets, progress

`GET|POST /api/panels`, `GET|PATCH|DELETE /api/panels/ID` (types: image iframe progress widget note files editor output terminal git trash;
extra fields `placement x y w h minimized ws sticky`). `GET|PUT /api/widgets`, `PUT|DELETE /api/widgets/NAME`,
`POST /api/widgets/NAME/reload`, `GET /api/source/WIDGET/SOURCE` (SSE). Progress: `GET /api/progress`, `GET|PUT
/api/progress/diagram` (text), `GET|PUT /api/progress/steps`, `POST /api/progress/steps {name,status?,title?,detail?,group?}`,
`PATCH /api/progress/steps/ID {status?,title?,detail?,group?}`,
`GET /api/progress/history[/NAME.mmd]`. Static: `/widgets/NAME/*`, `/sdk.js` (no token), `/files/uploads/N.ext`, `/custom/custom.css|js`.

A note PATCH can include `ifMarkdown: ORIGINAL_TEXT` alongside `props.markdown`. It checks the latest disk
content before writing and returns 409 for newer or malformed note files, preserving them; missing notes return 404.
Omit the condition for an unconditional update.

Named progress updates match an exact ID first, then a title ignoring case, and return the updated step.
New titles receive an unused ID even when their simplified names collide; creating a step requires `status`.
PATCH updates only supplied fields, preserving the current status and any manual edits to other fields.
PUT replaces the whole plan after validating every step (unique non-empty IDs, valid statuses and text details).
If a hand-edited steps file is malformed, the last valid plan stays visible and individual updates return 409;
repair the file or use PUT to replace it. Removing the file clears the checklist.

## Files and images

`POST /api/upload` (raw image body), `GET /api/file?path=` (images only), `GET /api/fs/list|read|resolve|download`,
`PUT /api/fs/write {path,text,mtime}`, `POST /api/fs/mkdir|newfile|rename|delete|upload` (upload: raw body, `?dir=&name=`).
All confined by `hatch-server serve --root DIR` when given. File reads return a numeric `mtime`; pass it unchanged
when saving to refuse changed or deleted files (409). Omit `mtime` for an unconditional write or explicit file creation.
Other timestamp types return 400. Saving through a symbolic link updates its real target and retains the link;
a dangling link returns 404 unless a timestamp was supplied, in which case the missing target is a 409 conflict.

## Doing things

`GET /api/limits[?refresh=1]` returns the Claude plan limits `{ claude: { fiveHour, sevenDay, fetchedAt } }` (each `{ label, percent, resetsAt }`) or `{ claude: { error } }`. The server gets them from one tiny headless `claude -p` run (Haiku, no tools), cached for 10 minutes; a forced refresh is throttled to one per 30 s. The header shows `5h 42%  wk 10%` and hides itself without the Claude CLI.

`POST /api/notify {text, level}`, `POST /api/copy {text}`, `POST /api/ask {question, choices?, freeText?}` then
`GET /api/ask/ID` until `answered`, `POST /api/ask/ID/answer {answer}`. Question IDs are opaque and unique across server starts. The first answer is retained: identical retries succeed,
conflicting answers return 409, and answers arriving after cancellation return 404. Without free text, answers must
match an offered choice. Choices are at most eight distinct non-empty strings of up to 200 characters; `freeText`
must be boolean.

Runs: `POST /api/runs {cmd, cwd?}`, `GET /api/runs`,
`GET /api/runs/ID`, `GET /api/runs/ID/stream` (SSE), `GET /api/runs/ID/output?max=N` (plain text tail), `DELETE /api/runs/ID` (stop). `POST /api/desktop`.
The run output endpoint accepts a positive integer `max` (default 65536, capped at 1048576 Unicode code points);
invalid limits return 400. Its truncation marker is additional to the requested tail. Run streams send
`event: truncated` before replay when the server has already discarded earlier history.
Run metadata includes `stopping` while Stop is pending and `signal` after a signal exit. DELETE sends SIGTERM,
then SIGKILL after two seconds if the process group is still running. Signal exit codes use 128 plus the signal
number (typically 143 for SIGTERM and 137 for SIGKILL); timeout exits remain 124.
Git: `GET /api/git/status?dir=`, `POST /api/git/stage|unstage {dir?, paths}`, `POST /api/git/commit {dir?, message}`.
Git commands run asynchronously, serialize mutations within each repository and have a twenty-second subprocess timeout
(504), so slow hooks leave terminal input responsive. Server shutdown stops active git process groups.
Discovery: `GET /api/tasks`, `GET /api/ports`, `GET /api/report` (markdown).

## Saved state (all plain files too)

`GET|PUT /api/commands` (saved commands and prompts), `GET|PUT /api/watches`, `GET|PUT /api/schedules`,
`GET /api/trash` (closed windows, newest first), `POST /api/trash/restore` (`{trashId}`, a short hex id (6+ chars, a hash of the trash file name) as listed by `GET /api/trash`; the old full file-name id is still accepted; latest when omitted), `DELETE /api/trash` (empty). `DELETE /api/panels/ID` moves the panel file to the trash.

`GET|PUT /api/bookmarks`.

Watch-only access permits existing `/api/runs/ID/stream` and `/api/pterm/NAME/stream` connections, but not
run listing, new commands, terminal input, filesystem or git APIs. Revoking a view token closes these streams
along with the main terminal and events streams. `GET /api/term` includes `viewOnly` so clients can suppress
input and resize before their first events snapshot.

## Proxy

`/proxy/PORT/path` forwards (HTTP and WebSocket upgrade) to `127.0.0.1:PORT` on the box; needs the token.


### Popup window preferences

Panel JSON also accepts `maximized: true` and `autoFocus: false`. These survive reloads.
PATCH either field to change it.
`opacity` (percent, 20 to 100) makes one window translucent (leader `o` asks for a transparency of 0-100 and stores 100 minus it); 100 keeps the window fully opaque even when a global transparency is set (a window with no `opacity` follows the global one). An explicit POST opening an existing singleton (progress, widget, or terminal)
restores it, applies supplied size/placement/workspace options, and raises it by default. Saved geometry stays
unless supplied. `activation` identifies a repeated open so a visible window can be raised again.
POST `/api/examples/NAME/open` accepts `w`, `h`, `maximized`, `autoFocus` and `ws` in its JSON body.
`editor` in config.json picks what opens text files: `"auto"` or unset (vim in a terminal window when installed, else the built-in editor), `"builtin"`, or a command name such as `"nvim"`. `POST /api/panels` applies it to `editor` requests (binary or missing files and `builtin: true` stay in the built-in editor); the window is a `terminal` panel named `vim-FILE-HASH`.
`imageSize` in config.json is a `WIDTHxHEIGHT` default for image windows (180–8192 wide, 90–8192 high).

The widget SDK forwards Ctrl+Shift+G, Ctrl+Shift+P, the leader chord (sent to the widget in `init`, default Ctrl+Space) and the key pressed after it to the host, so every leader action works with a widget focused. The host accepts shortcut messages
only from the focused widget frame, and answers with `hatch-leader` so the SDK knows whether the leader is still armed. Existing widget source subscriptions are unchanged.
