# help

`man @ecmaos/coreutils/help`

## Synopsis

```
help [-dms] [PATTERN ...]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Describes the shell's builtins. With no argument it lists every builtin's synopsis in two columns. PATTERN is a builtin name or a glob (`help 'p*'`).

## Options

- `-d` - print a one-line description of each topic
- `-s` - print only the synopsis
- `-m` - accepted; the default layout is already manual-like

## Exit status

0, or 1 when no topic matches.

## See also

`man`, `@ecmaos/coreutils/ecmash`
