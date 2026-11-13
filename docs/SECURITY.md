# Security model

Hatch gives whoever is logged in a shell on the box (the terminal, `hatch run`, widget `exec` sources, the file APIs). Everything
below is about who can get to that login, and what the pages Hatch shows can reach. It is a tool for isolated machines you
trust, not a hardened service.

## What it protects against

- **Accidental access.** Nothing is served without a login (except the login page, widget and page-window files, see below).
  The address you share or bookmark has no secret in it.
- **Neighbours on a trusted LAN who do not know the token.** A login needs the token (128 random bits) or a single-use code;
  failed attempts are rate limited per client address.
- **DNS rebinding.** Requests whose `Host` header is not an IP, `localhost`, this machine's name or an entry in
  `allowed-hosts` / `allowedHosts` / `HATCH_ALLOW_HOSTS` are refused before any other check.
- **Code in widgets and HTML pages reaching Hatch.** Widgets and `hatch open FILE.html` windows run in sandboxed frames with an
  opaque origin (no `allow-same-origin`): no cookie, no access to the Hatch page, no calls to the Hatch API. Hosted pages
  (`hatch host`) are served with the same sandbox.
- **Leaking a login through URLs.** No printed or opened link carries the token any more; a hosted page's link has no secret;
  the one-time login link is consumed on first use and redirects to a clean address (`Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`), so history keeps no code.

## What it does not protect against

- **The open internet.** One shared token, no accounts, no two-factor, rate limiting per address only. Do not expose Hatch
  there.
- **Anyone who can see the network path over plain HTTP.** Hatch serves HTTP. The token (typed at `/login`) and the session
  cookie cross the network in clear text. A listener on the path can log in. Use `--host 127.0.0.1` with Tailscale
  (`tailscale serve`) or an HTTPS reverse proxy (set `X-Forwarded-Proto: https` so the cookie is marked `Secure`). The server
  prints a warning when it listens on a non-loopback address.
- **Malicious local users.** Another user on the box can read the process list, connect to the loopback port, and (with the same
  account) read `config.json`. The state dir files are mode 0600; that does not help against root or the same user.
- **The terminal itself.** Whoever is logged in can run any command as the server's user. `--root` confines file APIs only, not
  the terminal, `hatch run` or widget commands. A watch-only link still shows everything the terminal shows.
- **A page you host reading its own folder.** See below: anyone logged in can read the hosted folder.

## Login, sessions, rotation

- `/login` takes the token in a password field and answers with the same message for any wrong input. The token is compared in
  constant time. `hatch-server token` prints the token (it is also in `config.json`, mode 0600); nothing else prints it.
- A login creates a **session**: a random 256-bit id in the `hatch_session` cookie (`HttpOnly; SameSite=Strict; Path=/`, 30
  days, plus `Secure` when `X-Forwarded-Proto: https` arrived with the request; that header is only believed after the Host
  check passed, and a client that lies about it only affects its own cookie). The server stores only a SHA-256 hash of the id in
  `sessions.json` (mode 0600, at most 200 sessions, oldest dropped first), so sessions survive a restart and a copy of the file
  cannot be used to log in. Sessions expire 30 days after the login (not extended by use).
- `hatch-server sessions` lists them (id = first 8 hex characters of the hash, created, last seen, address and user agent);
  `hatch-server logout ID` and `logout --all` end them; `hatch-server rotate-token` writes a new token (0600), ends all sessions,
  codes and hosted-page secrets, and prints the new token once. With the server running these go through its API; without it
  they edit the files. Open streams (events, terminal) of an ended session are closed within about 5 seconds.
- `hatch-server url --once` asks the running server for a **single-use code** (160 random bits, valid about 5 minutes, kept only
  as a hash in memory, compared in constant time, removed in the same step that finds it, so two simultaneous requests cannot
  both use it, at most 20 live codes). `GET /login?code=...` exchanges it for a session and redirects. The code is not logged. A
  chat tool or browser that pre-fetches links can use the code before you do: then make another.
- **Rate limit.** Wrong tokens from one client address (the socket address) lock that address out after 5 failures, for 30
  seconds, doubling with every further failure up to 15 minutes, forgotten after 15 quiet minutes; a log line records each
  lockout. It covers the login form, the `x-token` header, `?t=` and one-time codes. While locked out the token is not even
  compared (so the right token is refused too: no oracle). A valid session is never checked against the limiter, so a lockout
  cannot log a logged-in browser out. At most 5000 addresses are tracked. `X-Forwarded-For` is ignored, except that a request
  from the loopback address (a reverse proxy on the same box) is limited under the proxy's own last `X-Forwarded-For` entry.
  The `hatch` CLI sends `x-token` from `127.0.0.1` and is covered like everyone else: a flood of wrong tokens from the same
  address can make it wait.
- **Migration.** Old `?t=TOKEN` links and `hatch_token` cookies that hold the raw token still work: the link starts a session and
  redirects to the clean address; the cookie becomes a session on the next page load and is deleted. This is temporary.
- `x-token` for the CLI, MCP server and API is unchanged.
- **Watch-only (view) links** (`hatch-server url --view`, `--view-only`) are unchanged and may go away in a later version. They
  still put a second long-lived token in a `?t=` link and a cookie, with the old weaknesses.

## Hosted pages and page windows

- `hatch host FILE.html` serves the file's whole folder read-only (never dotfiles, `..`, or symlinks that lead out) at
  `/host/ID/NAME`. It needs a logged-in browser (a 401 page says to log in first), so **anyone logged in to this Hatch can read the
  whole folder**; the command asks before hosting.
- The document is served with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`: an opaque origin, no
  cookie, no Hatch API, no storage. Its css, scripts and images cannot send the cookie either, so the server injects `<base
  href="/host-r/SECRET/ID/">` as the first thing in `<head>`. SECRET is a fresh random 128-bit value per load, bound to that page,
  stored as a hash in memory (at most 500, cleaned up), valid until 10 minutes without use (2 hours at most), and ended by
  un-hosting or rotating the token. `/host-r/` serves read-only (GET/HEAD) without a cookie. The address bar shows only
  `/host/ID/NAME`. A `<base>` the page already has is merged (relative), dropped (root-relative) or respected (another site).
- Limits: `/x.css` style references are not under the base and do not load; the secret is visible to the page, to dev tools and
  to a proxy's logs while it lives; the page is not restricted from reaching the network (it is your page).
- `hatch open FILE.html` windows (`/page/KEY/...`) are separate: a random per-window key in the path is the credential, the same
  sandbox applies, and the key exists only while the window exists. Widget files and `/sdk.js` are served without a login; they
  contain only what was written into the widget folder.

## Reporting

Please report problems privately to the repository owner rather than in a public issue.
