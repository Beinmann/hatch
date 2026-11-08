#!/usr/bin/env sh
# Install Hatch: puts `hatch`, `hatch-server`, `hatch-mcp` (and the deprecated `hatch-ui`) on your PATH as symlinks to this checkout.
# Usage: ./install.sh [--prefix DIR] [--uninstall]     (default prefix: ~/.local, links go to DIR/bin)
set -eu

prefix="${HOME}/.local"
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || { echo "--prefix needs a directory" >&2; exit 2; }; prefix="$2"; shift ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "$0")" && pwd -P)"
bindir="$prefix/bin"
# name:target pairs
links="hatch:$here/bin/hatch.js hatch-server:$here/bin/hatch-server.js hatch-ui:$here/bin/ui.js hatch-mcp:$here/bin/mcp.js"
# the short alias `ui` was dropped; only our own old link (pointing at bin/ui.js) is removed
old_ui="$here/bin/ui.js"

if [ "$uninstall" = 1 ]; then
  links="$links ui:$here/bin/ui.js"
  for pair in $links; do
    name="${pair%%:*}"; target="${pair#*:}"; link="$bindir/$name"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then rm "$link" && echo "removed $link"; fi
  done
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required (node not found)" >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "Node.js 20 or newer is required (found $(node -v))" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || echo "warning: python3 not found; the terminal needs it (standard library only)" >&2
command -v tmux >/dev/null 2>&1 || echo "warning: tmux not found; Hatch attaches to a tmux session (apt install tmux)" >&2

chmod +x "$here/bin/hatch.js" "$here/bin/hatch-server.js" "$here/bin/ui.js" "$here/bin/mcp.js"
mkdir -p "$bindir"
# drop the old `ui` alias, but only if it is our own link
if [ -L "$bindir/ui" ] && [ "$(readlink "$bindir/ui")" = "$old_ui" ]; then rm "$bindir/ui" && echo "removed old alias $bindir/ui"; fi
for pair in $links; do
  name="${pair%%:*}"; target="${pair#*:}"; link="$bindir/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then echo "skipping $link: exists and is not a symlink" >&2; continue; fi
  if [ -L "$link" ] && [ "$(readlink "$link")" != "$target" ]; then
    echo "warning: replacing $link, which pointed to $(readlink "$link")" >&2
  fi
  ln -sf "$target" "$link" && echo "linked $link"
done
case ":$PATH:" in *":$bindir:"*) ;; *) echo "note: $bindir is not on your PATH" >&2 ;; esac
echo "done. Start with: hatch-server serve   (in your project dir; add .hatch/ to .gitignore)"
