# Editor test files

Everything in here exists to be opened in the **Editor** tab, one file per
view it is meant to exercise. Nothing in this folder is built, imported or
tested — it is a fixture for looking at.

| File | Opens as | What it is for |
| --- | --- | --- |
| `notes.md` | Markdown (live) | headings, **bold**, `code`, links, task lists |
| `sample.ts` | Code | comments, strings, numbers, keywords |
| `sample.py` | Code | a `#` comment language, for comment/uncomment |
| `sample.rs` | Code | block comments spanning lines |
| `sample.sql` | Code | `--` comments, a different keyword set |
| `setup.bat` | Code | `rem` and `::` — `rem` only counts at the start of a line |
| `sample.ps1` | Code | `<# … #>` block comments |
| `sample.lua` | Code | `--` and `--[[ … ]]` |
| `config.json` | JSON | keys told apart from values |
| `broken.json` | JSON | deliberately invalid, to see what that looks like |
| `people.csv` | Table | quoting, commas inside values, empty cells |
| `metrics.tsv` | Table | tab separated |
| `plain.txt` | Plain text | no grammar at all |
| `wide.txt` | Plain text | very long lines, for word wrap |
| `long.md` | Markdown | ~500 lines, for scrolling and line numbers |
| `bytes.bin` | Hex | every byte value 0–255, twice |

## Things worth trying

- Right-click the tab to switch views: a `.json` opened as **Plain text** shows
  the same characters with no colour, and as **Hex** shows the bytes.
- `Ctrl+F` in any text view; `Ctrl+H` to replace.
- `Ctrl+/` in `sample.py`, `sample.sql` and `setup.bat` — each uses its own
  comment marker.
- In `setup.bat`, note that `echo rem is a command` is *not* dimmed: `rem`
  comments only when it begins a line.
- Right-click for **Lines ▸** — sort, reverse, remove empty, remove duplicates,
  join — and **Change case ▸**. With nothing selected they act on the whole
  file; with a selection, only on the lines it touches.
- `Alt+↑`/`Alt+↓` to move a line, `Ctrl+D` to duplicate, `Ctrl+Shift+K` to delete.
- Word wrap and line numbers are on the right-click menu, per tab.
- In `bytes.bin`, type over a byte in either column. Changed bytes go amber
  until they are written; the file's length never changes.
- Drag any of these from the file tree onto an editor tab.
