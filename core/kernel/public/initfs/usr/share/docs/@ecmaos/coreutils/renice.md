# renice

`man @ecmaos/coreutils/renice`

## Synopsis

```
renice [-n] PRIORITY [-p] PID...
renice [-n] PRIORITY -g PGID...
renice [-n] PRIORITY -u USER...
```

## Description

Set the niceness of running processes to `PRIORITY` (-20 to 19, clamped): the processes named by id, every process in a process group, or every process of a user. For each it prints `PID (process ID) old priority OLD, new priority NEW`. The old form `renice PRIORITY PID...` works too.

Only root may lower a niceness or change another user's process; the others may raise their own. As with `nice`, the number is recorded (`/proc/PID/stat`) and nothing schedules by it.

Exit status is 1 if any process could not be changed.

## Options

```
  -n, --priority N  the new niceness
  -p, --pid         the arguments are process ids (the default)
  -g, --pgrp        the arguments are process group ids
  -u, --user        the arguments are user names or ids
```

## See also

`nice`, `ps`, `kill`
