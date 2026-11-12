export const COMMAND_HELP = {
  popup: `hatch popup: open useful windows from the terminal

  popup open progress|files|note      open a native Hatch popup
  popup open NAME                     open an installed widget (examples: hatch widget open NAME)
  popup create NAME [--from EXAMPLE]  create and open a widget (alias: popup new)
  popup generate "DESCRIPTION" [--name NAME]  generate with Claude Code, then open
  popup list                         list open popups (including minimized ones)
  popup close NAME|ID                close a popup by widget name, unique type or ID
  popup convert NAME|ID --to TYPE    turn a popup into note, widget or progress (diagram)
  popup rm NAME | reload NAME         manage widget files
  hatch widget list                  list installed widgets and bundled examples (example), including closed ones (and how to generate your own)

Window options: --size WIDTHxHEIGHT, --full, --no-focus, --ws WORKSPACE
For custom widget data and the SDK: hatch widget new --help
Window keys: press the leader key (Ctrl+Space), then t terminal · m minimize · q close · p palette`,
  progress: `hatch progress: keep a granular, visible plan

  progress plan "Inspect" "Build" "Verify"   replace the plan with concrete steps
  progress step "Build" running --detail "Implementing popup focus"
  progress step "Build" done
  progress step "Verify" blocked --detail "Need a test account" --group Verification
  progress show [--json]                    print the current plan (also: hatch progress)
  progress open                            open the progress details popup
  progress steps set FILE|-                 replace steps from JSON
  progress set FILE|-                       update an optional Mermaid diagram

Statuses: todo, running, done, blocked, skipped
Steps JSON: [{"id":"inspect","title":"Inspect","status":"running","detail":"Tracing focus","group":"Discovery"}]
Updates do not open popups or steal focus. Toggle the strip with Ctrl+Shift+G.
For persistent agent guidance: hatch agent init`,
  image: `hatch image PATH [--title TITLE] [--size WIDTHxHEIGHT] [--full] [--no-focus]

Open PNG, JPEG, GIF, WebP or SVG in Hatch. Use the wheel or +/− to zoom,
0 to fit and 1 for actual size. “Use path” returns the image to the terminal.
Default window size: imageSize in the project state config, e.g. "800x550".`,
  open: `hatch open FILE|DIR|URL [--title TITLE] [--size WIDTHxHEIGHT] [--full] [--no-focus]

Images open in the viewer, directories in Files, .html/.htm files render in a sandboxed page window (scripts run, no access to Hatch; edit the source with: hatch edit FILE), and other text files in vim in a terminal window (the built-in
editor when vim is not installed; config key editor: "auto" | "builtin" | a command such as "nvim").
HTTP(S) URLs open in a popup; localhost URLs use the Hatch proxy unless --direct is supplied.`,
  agent: `hatch agent init [--target claude|codex|both] [--dir PROJECT]
hatch agent show

Add a managed Hatch workflow block to project instruction files. Existing rules
are preserved; rerunning updates only Hatch's block. Start a new agent session
to pick up the instructions. Setup does not require a running Hatch server.`,
};
