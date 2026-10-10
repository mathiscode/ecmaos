# readonly

`man @ecmaos/coreutils/readonly`

## Synopsis

```
readonly [-p] [NAME[=VALUE] ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Makes variables unchangeable: assigning to one, or unsetting it, is an error that fails that command and goes on.

## Options

- `-p` -- list the readonly variables (also with no NAME)

## Exit status

0, or 1 when a NAME is invalid.

## See also

`declare`, `export`
