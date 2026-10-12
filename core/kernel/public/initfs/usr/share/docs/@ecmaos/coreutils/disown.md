# disown

`man @ecmaos/coreutils/disown`

## Synopsis

```
disown [-a] [%JOBSPEC | PID] ...
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Removes jobs from the shell's job table: they keep running, but are no longer listed and no `Done` notice is printed for them.

## Options

- `-a` - remove every job

## Exit status

0, or 1 when a job does not exist.

## See also

`jobs`, `bg`
