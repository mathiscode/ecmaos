# return

`man @ecmaos/coreutils/return`

## Synopsis

```
return [N]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Leaves a function, or a script run with `source`, with status N (default: the status of the last command). Outside both it prints a diagnostic.

## Exit status

N.

## See also

`exit`, `source`
