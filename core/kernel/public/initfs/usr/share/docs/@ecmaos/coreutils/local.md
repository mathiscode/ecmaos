# local

`man @ecmaos/coreutils/local`

## Synopsis

```
local [NAME[=VALUE] ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Declares variables local to the current function call; the previous value is back when the function returns, and a function it calls sees the local one. A bare `local NAME` leaves NAME unset, not empty. Arrays can be local too (`local -a`). Outside a function it is an error.

## Examples

```
f() { local x=1; g; }
```

## Exit status

0, or 1 outside a function.

## See also

`declare`, `export`
