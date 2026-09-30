---
"@ecmaos/kernel": minor
---

## One line editor

`Terminal` carried four editors: the prompt's `keyHandler`, `readline`, and one each for the mobile
text field and the mobile password field. They shared a `_cmd`/`_cursorPosition` pair that five other
methods also mutated, and repeated the same wrap-aware cursor math at about a dozen sites, which is
how they drifted apart.

The editing is now one `LineEditor` (`lib/line-editor.ts`), a model plus the repaint it implies,
talking to the screen through a three-member host. The prompt and `readline()` share it and one
`_editKey`, so they cannot disagree about what a key does; the two mobile paths are one function that
differs only in echo. History (`lib/history.ts`) and completion (`lib/completion.ts`) are separate
modules with injected dependencies.

### New

- Kill ring: `^W`, `^U`, `^K`, `^Y`, `Alt-D`, `Alt-Backspace`. Consecutive kills accumulate, so
  `^W^W^Y` restores both words.
- Emacs motion: `^A`, `^E`, `^B`, `^F`, `^D`, `Alt-B`, `Alt-F`.
- `^R` incremental reverse search. Enter runs the match, Escape or `^G` cancels back to what was
  typed, any other key accepts the match into the line and then acts.
- `$PS2` for the continuation prompt, and `\[`/`\]` around text that takes no columns. They were
  printed literally, and counted in the width.
- Prompt escapes `\t \T \A \d \! \# \j \e \a \r \\`.
- `HISTSIZE`, `HISTFILESIZE` and `HISTCONTROL` (`ignorespace`, `ignoredups`, `ignoreboth`, `erasedups`).

### Fixed

- ArrowUp re-read the entire history file on every cache miss, and every command re-read it to check
  its last byte. History is read once and appended to blind. A file an older terminal wrote has no
  final newline, and is appended to correctly.
- The history file grew without bound. It is trimmed to `HISTFILESIZE`.
- A line that filled a row exactly moved the cursor one row too far, because a terminal defers the
  wrap. The editor forces it.
- Tab on a line ending in `/` ran `ls`, which no real shell does. It cycles through the directory.
- An unbound `^X` inserted a control character into the line.
- `^C` left a continuation prompt stuck in continuation.
- Pasting text with newlines corrupted the cursor arithmetic; newlines become spaces.
- The `Ctrl+Shift+F1` handler was never disposed with the terminal.
