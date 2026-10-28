# flock

`man @ecmaos/coreutils/flock`

## Synopsis

```
flock [-s|-x|-u] [-n|-w SECONDS] [-E CODE] FILE COMMAND [ARGUMENT]...
flock [OPTIONS] FILE -c COMMAND
```

## Description

Run COMMAND while holding a lock on FILE, so that scripts take turns. FILE is created if it is missing. `-c` runs COMMAND through `$SHELL -c`.

`-n` gives up at once if someone else holds the lock, and `-w` gives up after SECONDS. Either way flock then exits with 1, or with the code `-E` sets.

The lock is a whole-file record lock: the kernel's `fcntl` locks, which `lockf` and `fcntl` in C programs also take, and which `lslocks` lists. On Linux, `flock(2)` locks are a separate kind. Here they are the same kind.

`flock FD`, which on Linux locks a descriptor the shell holds and leaves it locked, is refused with status 64. A lock belongs to the process that takes it, so it would be released as soon as `flock` exited. `-F` (no fork) is refused too, since there is no exec.

## Options

```
  -s, --shared              a shared (read) lock
  -x, --exclusive           an exclusive (write) lock, the default
  -u, --unlock              release a lock
  -n, --nonblock            fail rather than wait
  -w, --timeout SECONDS     wait at most this long
  -E, --conflict-exit-code N  the status when the lock is not taken (1)
  -c, --command COMMAND     run COMMAND through the shell
      --verbose             say how long the wait took
```

## See also

`lslocks`, `fuser`
