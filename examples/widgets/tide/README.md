# Tide

A planner for the current day: loose cards in a pool, and one timeline you place them on. Open it with
`hatch widget open tide`.

## The file

The day is `<state dir>/tide/today.json`. It is outside the widget folder on purpose, so closing the window or
removing the widget keeps it. On the first open of a new day, the old file is moved to
`<state dir>/tide/archive/YYYY-MM-DD.json` and the board starts empty (categories and the day end carry over).

Hand edits work: the open widget re-reads the file every few seconds and shows it, unless it has an unsaved change
of its own. Malformed values are repaired or dropped when it loads (see `model.js`, `sanitize`).

```json
{
  "v": 1,
  "day": "2026-01-05",
  "wall": 1320,
  "cats": [{ "id": "a", "name": "home", "color": "#f0b36a" }],
  "cards": [
    { "id": "c1", "t": "clean the hallway", "cat": "a", "len": 30, "s": 675, "x": 0, "y": 0 },
    { "id": "c2", "t": "write the report", "cat": null, "len": 120, "s": null, "x": 24, "y": 44, "raw": true,
      "steps": ["collect numbers", "outline", "write"], "q": "which format?" }
  ],
  "goals": [{ "id": "g3", "t": "prepare slides", "cat": "b", "len": 240 }],
  "plan": { "at": "09:40", "m": { "c1": { "s": 660, "len": 30 } } },
  "seq": 10
}
```

- Times are minutes since local midnight. `wall` is where the day ends (720 to 1440).
- A card with `s` is placed on the timeline (a multiple of 15). A card with `"s": null` is loose and sits at `x`/`y` in the pool.
- `len` is the estimate in minutes (15 to 480, multiples of 15) and the width of the card.
- Optional card fields: `done`, `locked` (placed cards only), `took` (minutes it really took), `steps` (shown on hover and
  used by "split"), `q` (an open question, shown as a ?), `goal` and `part` (set by "split"), `raw` (not yet sorted into a category).
- `cats` are the colour legend; a card's `cat` is one of their ids, or `null`.
- `goals` list the parents of split cards; their parts are the cards with that `goal`.
- `plan` is the snapshot taken by "lock plan": the placed cards at that moment. It is only compared with the timeline, never enforced.
- Give new cards a unique `id` and bump `seq` past the numbers you used.

## Saving

The widget saves through the `save` source in chunks (`B`/`A` write a temporary file, `C` moves it into place), the same
way the board widget does. A save with the id `YYYY-MM-DD` (`B:2026-01-04 ...`, `C:2026-01-04`) writes to the archive.
