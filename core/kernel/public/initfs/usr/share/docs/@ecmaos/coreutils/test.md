# test, [

`man @ecmaos/coreutils/test`

## Synopsis

```
test EXPRESSION
[ EXPRESSION ]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Evaluates a condition. `[` is the same command and requires a closing `]` as its last argument. `[[ ... ]]` is a separate shell keyword with pattern (`==`) and regular-expression (`=~`) matching and no word splitting.

## Options

- `-e FILE, -f FILE, -d FILE` - exists; is a regular file; is a directory
- `-r, -w, -x FILE` - readable, writable, executable
- `-s FILE` - exists and is not empty
- `-L FILE, -h FILE` - is a symbolic link
- `-n STRING, -z STRING` - not empty; empty
- `A = B, A != B` - strings are equal; differ
- `N -eq M, -ne, -lt, -le, -gt, -ge` - integer comparison
- `! E, ( E ), E1 -a E2, E1 -o E2` - not, grouping, and, or

## Examples

```
[ -d /tmp ] && echo yes
test "$a" -lt 10
```

## Exit status

0 when true, 1 when false, 2 for an error.

## See also

`@ecmaos/coreutils/ecmash`
