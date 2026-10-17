# runlevel

`man @ecmaos/kernel/commands/runlevel`

## Synopsis

```
runlevel
```

## Description

Prints `N` and the runlevel (`N 5`; N means there is no previous level, which init does not keep), or `unknown` with status 1 when there is none: neither `telinit` nor an `initdefault` entry has set one. The level is read from `/run/runlevel` and `/etc/inittab`.
