# fuser

`man @ecmaos/coreutils/fuser`

## Synopsis

```
fuser [-a|-s] [-m|-M] [-k [-i] [-SIGNAL]] [-uv] NAME...
fuser -l
```

## Description

Show which processes use each NAME, from what `/proc/<pid>` links to. The kinds of use are:

- `f`: an open descriptor
- `c`: the working directory
- `r`: the root
- `e`: the program

The names go to standard error and the pids to standard output, so `kill $(fuser FILE 2>/dev/null)` works. `-v` shows a table with user, pid, use and command.

`-m` takes NAME as a filesystem and lists every process using a file on it. `-k` sends `SIGKILL`, or `-SIGNAL`, to each process, and `-i` asks first. The status is 0 when some process was found.

There are no network sockets to look up, so `-n tcp` and `-n udp` are refused.

## Options

```
  -a  list names nothing uses too
  -i  ask before killing
  -k  kill the processes
  -l  list the signal names
  -m  NAME is a filesystem
  -M  only if NAME is a mount point
  -s  silent
  -u  show user names
  -v  verbose table
```

## See also

`lsof`, `lslocks`, `kill`
