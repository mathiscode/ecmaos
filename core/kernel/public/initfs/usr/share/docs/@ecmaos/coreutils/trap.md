# trap

`man @ecmaos/coreutils/trap`

## Synopsis

```
trap [-lp] ['COMMAND'] [SIGNAL ...]
trap - SIGNAL ...
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Runs COMMAND when the shell receives a signal or reaches an event. SIGNAL is any Linux signal by name (with or without `SIG`) or number, or `EXIT` (the shell ends), `ERR` (a command fails outside a condition), `DEBUG` or `RETURN`. `trap - SIGNAL` restores the default, `trap '' SIGNAL` ignores it, and `trap` alone lists the traps in force. `KILL` and `STOP` cannot be caught. An unknown name is `invalid signal specification`. The handler runs between commands, not in the middle of one.

## Options

- `-l` -- list the signal names
- `-p` -- print the traps as commands

## Examples

```
trap 'echo bye' EXIT
trap 'rm -f "$tmp"' INT TERM
```

## Exit status

0, or 1 for an invalid signal.

## See also

`kill`, `@ecmaos/coreutils/ecmash`
