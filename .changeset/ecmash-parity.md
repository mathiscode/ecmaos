---
"@ecmaos/coreutils": minor
"@ecmaos/kernel": minor
---

## ecmash options, aliases, traps, completion, and a login shell that is `$SHELL`

`ecmash` gains `set -e`, `-u`, `-x` and `-o pipefail` (other options are refused rather than ignored), `alias`/`unalias`, `trap` for `EXIT` and `INT`, Tab completion, and `[n]+  Done` notices for finished background jobs just before the next prompt.

A user whose shell is `/bin/ecmash` now lands in it at login, on every TTY; leaving it (`exit`, `^D`) returns to the shell built into the kernel.

Fixed on the way: `head -3` and `tail -3` ignored the count; line recall and completion in `ecmash` dropped the prompt; the shared completion module imported Node's `path`, which does not exist in a worker.
