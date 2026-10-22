# ipcrm

`man @ecmaos/kernel/commands/ipcrm`

## Synopsis

```
ipcrm [-q ID] [-Q KEY] [-m ID] [-M KEY] [-s ID] [-S KEY]...
ipcrm -a [msg|shm|sem]
ipcrm msg|shm|sem ID...
```

## Description

Removes System V IPC objects, by id or by key, as `ipcs` lists them. A program left waiting on a removed queue or semaphore array fails with `EIDRM`. A shared memory segment that is still attached is only marked (`dest` in `ipcs -m`) and goes when its last attachment does. Only the object's owner or creator, or root, may remove it.

Each object that cannot be removed is reported (`invalid id`, `invalid key`, `permission denied for id`), the rest are still removed, and the status is then 1.

## Options

- `-q, --queue-id ID`, `-Q, --queue-key KEY` - a message queue
- `-m, --shmem-id ID`, `-M, --shmem-key KEY` - a shared memory segment
- `-s, --semaphore-id ID`, `-S, --semaphore-key KEY` - a semaphore array
- `-a, --all [msg|shm|sem]` - every object (of the kind given) the caller may remove
- `-h, --help` - display usage and exit

A key is a number, decimal or `0x` hexadecimal.

## See also

`@ecmaos/kernel/commands/ipcs`
