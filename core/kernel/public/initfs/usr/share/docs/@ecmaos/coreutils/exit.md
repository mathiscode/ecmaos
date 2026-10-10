# exit

`man @ecmaos/coreutils/exit`

## Synopsis

```
exit [N]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Ends the shell (or a `( )` subshell, or a `$( )` substitution) with status N, default the status of the last command. The `EXIT` trap runs first.

## Exit status

N.

## See also

`logout`, `trap`, `return`
