# bg

`man @ecmaos/coreutils/bg`

## Synopsis

```
bg [%JOBSPEC]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Resumes a stopped job in the background and returns at once. The job is the one named by JOBSPEC, or the most recent. A job is stopped with `^Z`.

## Exit status

0, or 1 when there is no such job or it is already running in the background.

## See also

`fg`, `jobs`, `disown`, `wait`
