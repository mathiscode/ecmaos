---
"@ecmaos/coreutils": minor
"@ecmaos/kernel": minor
---

## One shared shell state, and variables that are not exported stay in the shell

The kernel shell and `/bin/ecmash` now keep their variables, arrays, `local` frames, `readonly`, functions, aliases, traps and `set` options in one shared `ShellState` (`@ecmaos/coreutils/lib/shell-core/state`), so a scoping or export rule is written once.

**Behavior change:** a variable created by a plain assignment (`X=1`) is no longer part of a child process's environment, or of what `env` prints, until `export X`. This is what bash does; before, every shell variable leaked into every child in the kernel shell. Variables the shell started with, those read from `/etc/env` and `~/.env`, and a prefix assignment (`X=1 cmd`, for that command) are still passed on. `export NAME` without a value, and `declare -x`, now work in the kernel shell.

`ecmash` also gains `readonly` and `declare -r`, a working `$-`, and real `local` frames.
