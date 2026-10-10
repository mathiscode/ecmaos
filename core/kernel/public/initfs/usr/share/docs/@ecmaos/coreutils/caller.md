# caller

`man @ecmaos/coreutils/caller`

## Synopsis

```
caller [EXPR]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Reports where the current function was called from. Without EXPR it prints `LINE FILE`; with a number it prints `LINE FUNCTION FILE` for that many frames up, which is how a script prints a stack trace. `FILE` is `NULL` for the top level of a script. It reads `BASH_SOURCE`, `BASH_LINENO` and `FUNCNAME`.

## Examples

```
f() { caller; }
f          # 3 script.sh
```

## Exit status

0, or 1 when there is no such frame.

## See also

`@ecmaos/coreutils/ecmash`
