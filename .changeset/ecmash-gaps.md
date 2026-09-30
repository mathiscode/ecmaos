---
"@ecmaos/coreutils": minor
"@ecmaos/kernel": minor
---

## ecmash: arrays, subshells, process substitution, more traps, and `^Z`/`fg`/`bg`

`ecmash` gains indexed arrays (`a=(x y)`, `a+=(z)`, `a[i]=v`, `${a[@]}`, `unset a[i]`, `declare -a`), `( list )` subshells, `<(cmd)` and `>(cmd)`, `trap` for `ERR`, `HUP`, `QUIT`, `USR1`, `USR2`, `PIPE`, `ALRM`, `TERM` and `CHLD` as well as `EXIT` and `INT`, and real job control: `^Z` stops the foreground job, and `jobs`, `fg`, `bg`, `disown` and `wait %n` work on it.

Subshells are also parsed by the shared statement parser, so the kernel shell runs them too (as a snapshot of variables, arrays, functions and the directory). A subshell followed by `&&`, `||` or `|` is refused with a message.

The job-control shim gains `WUNTRACED` (a wait can report a stopped child) and `tcsetpgrp`, and workers can read the signals that arrived while they sat in an async syscall, which upstream otherwise discards.

The kernel test suite now runs on four workers: with one per core, about half of all full runs failed on a different timing-sensitive test each time, and none failed in isolation.
