# Commands widget (for agents)

Use this when the user wants shell commands to run on a system you have no access to (another machine, a box without Hatch or an AI). You write the list; the user copies the commands with one click and runs them in their own terminal. The widget only copies, it never runs anything. The output comes back through the chat, by hand, on purpose (the user may redact it).

1. Open the widget (once; harmless if already open): `hatch widget open cmds`
2. Write the list to `<state dir>/widgets/cmds/data/cmds.json`. The state dir is `$HATCH_STATE` if set, otherwise `~/.hatch`. Writing the file replaces the shown list within about a second. Overwrite the whole file.

```json
{
  "id": "disk-check-1",
  "title": "Find what fills the disk",
  "groups": [
    {
      "label": "on the NAS",
      "commands": [
        { "cmd": "df -h", "note": "which volume is full" },
        { "cmd": "du -xh --max-depth=1 /srv | sort -h | tail -n 5", "note": "largest folders" }
      ]
    }
  ]
}
```

- `id`: change it for every new list. The user's "copied" ticks are remembered per list; a new id starts clean. Optional but recommended.
- `title`: optional heading.
- `groups[].label`: which system the commands are for (free text). Use one group per system, in the order the user should go through them.
- `commands`: in the order to run them. An entry is `{ "cmd": "...", "note": "why, optional" }` or just a string. Multi-line commands are copied as is.
- Keep commands independent where you can; the user runs them one by one and pastes the outputs back. Prefer read-only commands first, and say in `note` when a command changes something.
- Text is copied exactly as written, with no trailing newline.

Check the file is valid JSON; a broken file shows an empty list.
