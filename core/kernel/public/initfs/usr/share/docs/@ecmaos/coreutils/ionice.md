# ionice

`man @ecmaos/coreutils/ionice`

## Synopsis

```
ionice [-c CLASS] [-n LEVEL] COMMAND [ARG]...
ionice -p PID...
```

## Description

Run a command with an I/O scheduling class, or show a process's. Nothing here schedules I/O, so the class and level are checked and not applied; the command runs as it is and `-p` prints `none: prio 0`.

## Options

```
  -c, --class CLASS     0 none, 1 realtime, 2 best-effort, 3 idle (or the name)
  -n, --classdata NUM   priority 0..7 within the class
  -p, --pid PID...      show these processes instead
```

## Example

```
ionice -c 3 tar czf backup.tgz data
```
