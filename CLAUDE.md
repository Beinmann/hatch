# Hatch

A small Node server (one per isolated box) that serves a browser page: a real terminal attached to tmux, plus panels
(images, progress diagram, widgets, notes) that Claude drives with the `hatch` CLI (the server is `hatch-server`; `hatch-ui` is a deprecated alias). The code is the source of truth; docs are in `docs/`.

## Public repo
This repo is published on GitHub (MIT). Everything in it, including git history and commit messages, is public. Keep private information out: no secrets, tokens, hostnames, usernames, emails, absolute home paths, private project names, ticket numbers or text from the private workspace around it. Use `~` and placeholders. If unsure whether something is private, leave it out and ask.

## Rules
- Zero npm dependencies. Node 20+ standard library, python3 standard library (pty helper only), vendored xterm and mermaid in `public/`.
- Files in the state dir (`~/.hatch/`) are the source of truth; the UI is a live projection. Hand edits must work. Malformed files give a warning, never a crash.
- Keep the repo clean: no hostnames, usernames, absolute home paths or private project names in code, tests, docs or fixtures (use `~` and placeholders). No ticket numbers or references to private workspace files in code, docs or commit messages.
- One instance per user. The state dir (server and clients alike) is `--state`, then `HATCH_STATE`, then `~/.hatch`; never the cwd, never walking up. A plain `serve|start` creates `~/.hatch` silently; an explicit `--state`/`HATCH_STATE` to a missing or invalid dir needs confirmation or `--yes`. `hatch migrate` imports an old project `.hatch` as a workspace. `hatch` picks the workspace from `--ws`, `HATCH_WORKSPACE`, then `main`.
- Tests and manual runs: `HOME` must be a temp dir (the default state dir is `~/.hatch`) and `HATCH_STATE`/`HATCH_URL`/`HATCH_WORKSPACE` of the developer's shell must not leak in.
- Small files, comments that say why, errors that say what went wrong and how to fix it.
- Test: `node --test "test/*.test.js"` (real server on an ephemeral port, `cat` instead of tmux; one gated test uses real tmux).
- Do not claim browser behaviour works unless it was seen in a browser. A headless Chromium (Playwright) may be used OUTSIDE the repo; it is not a dependency.
