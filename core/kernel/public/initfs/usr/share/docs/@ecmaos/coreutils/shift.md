# shift

`man @ecmaos/coreutils/shift`

## Synopsis

```
shift [N]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Drops the first N (default 1) positional parameters, so `$2` becomes `$1`. It fails if N is larger than `$#`.

## Examples

```
while [ $# -gt 0 ]; do echo "$1"; shift; done
```

## Exit status

0, or 1 when N is out of range.

## See also

`set`, `getopts`
