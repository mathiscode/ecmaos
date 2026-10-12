# ps

`man @ecmaos/kernel/commands/ps`

## Synopsis

```
ps
```

## Description

Lists every process on the machine: pid, parent pid, owner and command, read from `/proc` (the same files `killall` reads). Every worker-hosted program, WASM module, DOM app and kernel command has an entry; `/sbin/init` is pid 1.

## Output

```
PID	PPID	UID	COMMAND
```

## See also

`@ecmaos/kernel/commands/kill`, `@ecmaos/kernel/commands/killall`, `@ecmaos/coreutils/free`
