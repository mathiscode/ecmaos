# setsid

`man @ecmaos/coreutils/setsid`

## Synopsis

```
setsid [-c] [-w] PROGRAM [ARGUMENT]...
```

## Description

Run PROGRAM in a new session, away from this terminal and its job control. There is no exec here, so PROGRAM always runs as a child, the leader of its own session, as `-f` asks for on Linux.

`setsid` returns at once unless `-w` is given, in which case it waits and returns PROGRAM's status. This is what a shell sees from `setsid` on Linux, because a command the shell runs leads its own process group. `-c` gives the new session this terminal as its controlling terminal.

## Options

```
  -c, --ctty   make the current terminal the new session's
  -f, --fork   always fork (it always does)
  -w, --wait   wait for PROGRAM and return its status
```

## See also

`nohup`, `ps`
