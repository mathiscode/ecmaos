---
"@ecmaos/kernel": minor
---

## Process substitution, and `pipe`/`dup`/`dup2` for programs

### New

- `<(cmd)` and `>(cmd)`. `diff <(a) <(b)`, `while read l; do ...; done < <(cmd)` and
  `cmd | tee >(a) >(b)` work. Each expands to a path in `/tmp`, removed when the command finishes;
  bash does the same where `/dev/fd` cannot be used, and a child here inherits only fds 0 to 2, so
  `/dev/fd/63` would name nothing in it. It does not stream: `<(cmd)` runs to completion before the
  reader starts, and `>(cmd)` runs after the writer finishes, so an endless producer never yields a path.
- `pipe`, `dup` and `dup2` in `ecmaosSyscalls`, for programs run by `/bin/node`.

### Fixed

- A redirected block applied its `>` to every stage of a pipeline inside it, so
  `for i in 1; do echo a | cat; done > f` sent `echo` to the file and hung `cat` on an empty pipe.
  Only the last stage owns the block's stdout.
