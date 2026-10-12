# mapfile

`man @ecmaos/coreutils/mapfile`

## Synopsis

```
mapfile [-t] [-n COUNT] [-s COUNT] [-d DELIM] [-O ORIGIN] [ARRAY]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Reads standard input into an indexed array, one element per line (`MAPFILE` by default). Each element keeps its newline unless `-t` removes it.

## Options

- `-t` - remove the trailing delimiter from each line
- `-n COUNT` - copy at most COUNT lines (0: all)
- `-s COUNT` - skip the first COUNT lines
- `-d DELIM` - end lines at the first character of DELIM
- `-O ORIGIN` - assign from index ORIGIN instead of clearing the array

## Examples

```
mapfile -t lines < /etc/shells
echo "${#lines[@]}"
```

## Exit status

0.

## See also

`readarray`, `read`
