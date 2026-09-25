# ps

`man @ecmaos/kernel/commands/ps`

## Synopsis

```
ps
```

## Description

Lists every real process in the system: pid, command, and status. The process table is `@zenfs/linux`'s own process registry -- real for every worker-hosted program and every main-thread-fallback program alike (WASM modules that can't run in a worker, DOM apps under `/bin/app`, kernel commands). It is reachable only from the main thread, so `ps` reaches it through the `ps_list` main-thread custom syscall, the same one `df`, `kill`, and `killall` use for their own main-thread-only needs.

## Output

```
PID	COMMAND			STATUS
```

## Notes

There is no persistent PID 1 process yet -- `/boot/init` runs as a script during boot rather than as a long-lived process, so it will not appear in `ps` output as `init`. See the root README's Known gaps section.

## See also

`@ecmaos/kernel/commands/kill`, `@ecmaos/kernel/commands/killall`, `@ecmaos/coreutils/free`
