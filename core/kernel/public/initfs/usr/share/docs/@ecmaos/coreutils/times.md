# times

`man @ecmaos/coreutils/times`

## Synopsis

```
times
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. bash prints the user and system CPU time of the shell and its children. A browser keeps no per-process CPU accounting, and wall-clock numbers in those fields would mislead, so `times` says `times: not available` and exits 1.

## Exit status

1.

## See also

`@ecmaos/kernel/commands/time`
