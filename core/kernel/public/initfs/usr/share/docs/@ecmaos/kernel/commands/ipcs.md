# ipcs

`man @ecmaos/kernel/commands/ipcs`

## Synopsis

```
ipcs [-q] [-m] [-s] [-a]
```

## Description

Shows the System V IPC objects that programs have made with `msgget`, `shmget` and `semget`: message queues, shared memory segments and semaphore arrays, with each one's key, id, owner and permissions. It reads `/proc/sysvipc/msg`, `shm` and `sem`, which list them in Linux's format. With no option it shows all three kinds.

An object stays until it is removed, even after the program that made it ends; `ipcrm` removes one.

## Options

- `-q, --queues` - message queues
- `-m, --shmems` - shared memory segments (`dest` in the status marks one removed while still attached)
- `-s, --semaphores` - semaphore arrays
- `-a, --all` - all three (the default)
- `-h, --help` - display usage and exit

## See also

`@ecmaos/kernel/commands/ipcrm`
