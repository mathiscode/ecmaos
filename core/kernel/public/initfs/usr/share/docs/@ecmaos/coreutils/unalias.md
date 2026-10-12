# unalias

`man @ecmaos/coreutils/unalias`

## Synopsis

```
unalias [-a] NAME ...
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Removes each NAME from the aliases.

## Options

- `-a` - remove every alias

## Exit status

0, or 1 when a NAME is not an alias.

## See also

`alias`
