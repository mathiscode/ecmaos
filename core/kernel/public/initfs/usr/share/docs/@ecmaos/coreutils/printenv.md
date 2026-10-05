# printenv

`man @ecmaos/coreutils/printenv`

Print environment variables.

## Synopsis

```
printenv [OPTION]... [NAME]...
```

## Description

With no `NAME`, prints every variable as `NAME=VALUE`. With names, prints just their values, one per line, and
exits 1 if any of them is not set.

## Options

- `-0`, `--null`: end each line with a NUL instead of a newline.
- `--help`: show usage.

## Examples

```
printenv HOME
printenv PATH SHELL
```
