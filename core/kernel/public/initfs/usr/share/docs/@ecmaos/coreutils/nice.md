# nice

`man @ecmaos/coreutils/nice`

## Synopsis

```
nice [-n N | -N] [COMMAND [ARG]...]
```

## Description

Run `COMMAND` with its niceness adjusted by `N` (10 if none is given), or, with no command, print the current niceness. Niceness runs from -20 (favoured) to 19 and is clamped to that; a child process starts with its parent's. Only root may lower it; for anyone else the attempt prints a warning and the command runs unchanged, as GNU `nice` does.

Niceness is kept, inherited and shown (`/proc/PID/stat`, `ps -o ni`), but nothing schedules by it: every process is a worker thread that the browser runs as it chooses, so `nice` does not make anything run slower or faster.

Exit status: that of `COMMAND`; 125 if `nice` itself fails; 126 if the command cannot be run; 127 if it is not found.

## Options

```
  -n, --adjustment=N   add N to the niceness
  -N                   the same, written as -5 or --5 (the old form)
```

## See also

`renice`, `ps`, `top`
