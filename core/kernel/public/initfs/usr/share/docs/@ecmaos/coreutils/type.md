# type

`man @ecmaos/coreutils/type`

## Synopsis

```
type [-t] [-p] NAME ...
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Says how each NAME would be interpreted as a command: an alias, a keyword, a builtin, a function or a file (with its path).

## Options

- `-t` -- print only the kind: `alias`, `keyword`, `builtin`, `function` or `file`
- `-p` -- print only the path, and nothing for a name that is not a file

## Examples

```
type cd ls
```

## Exit status

0 when every NAME is found, 1 otherwise.

## See also

`command`, `hash`, `alias`
