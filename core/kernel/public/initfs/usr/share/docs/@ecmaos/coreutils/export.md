# export

`man @ecmaos/coreutils/export`

## Synopsis

```
export [-n] [-p] [NAME[=VALUE] ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Marks variables for export: only exported variables are in the environment of the programs the shell starts. A plain `X=1` makes a shell variable that children do not see; `export X` (or `export X=1`) makes it visible to them. `X=1 command` exports X for that command only.

## Options

- `-n` - remove the export attribute
- `-p` - list the exported variables as `NAME=VALUE`

## Examples

```
export EDITOR=vim
export -p
```

## Exit status

0, or 1 when a NAME is invalid or readonly.

## See also

`declare`, `readonly`, `env`
