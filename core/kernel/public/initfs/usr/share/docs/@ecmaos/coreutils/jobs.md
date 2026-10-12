# jobs

`man @ecmaos/coreutils/jobs`

## Synopsis

```
jobs [-l]
```

## Description

A shell builtin, available in both the shell built into the kernel and `/bin/ecmash`. Lists the shell's jobs: `[N]+  Running  COMMAND`, with `+` the current job and `-` the previous one. Finished background jobs are reported once, just before the next prompt, as `Done`.

A job is named `%N` (job number N), `%%` or `%+` (the current job), `%-` (the previous one), or by a process id.

## Options

- `-l` - also show process ids

## Exit status

0.

## See also

`bg`, `fg`, `wait`, `disown`
