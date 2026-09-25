# kill

`man @ecmaos/kernel/commands/kill`

## Synopsis

```
kill [-s SIGNAL | -SIGNAL] PID...
kill -l
```

## Description

Sends a signal to one or more real, worker-hosted `execve` processes by pid (`SIGTERM` if none is given). Because every command in ecmaOS 1.0.0 runs as a genuine `@zenfs/linux` process with a real pid, `kill` delivers a real signal through the same mechanism the process's own runtime (worker or main-thread fallback) already listens on -- this is not a simulated interrupt.

## Options

- `-s, --signal SIGNAL` -- signal to send, by name (`TERM`) or number (`15`)
- `-SIGNAL` -- shorthand, e.g. `-9` or `-KILL`
- `-l, --list` -- list known signal names
- `--help` -- display usage and exit

## Notes

A main-thread, non-asyncify WASM module cannot be preempted even by a real signal delivery -- see the root README's Known gaps section. Every other process type (coreutils, kernel commands, worker-hosted WASM/WALI, DOM apps under `/bin/app`) is genuinely killable.

## See also

`@ecmaos/kernel/commands/killall`, `@ecmaos/kernel/commands/ps`
