# fg

`man @ecmaos/coreutils/fg`

## Synopsis

```
fg [%JOBSPEC]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Resumes a stopped or backgrounded job in the foreground and waits for it. The job gets the terminal back, so `^C` and `^Z` reach it again.

## Exit status

The status of the job, or 1 when there is no such job.

## See also

`bg`, `jobs`, `wait`
