# chroot

`man @ecmaos/coreutils/chroot`

## Synopsis

```
chroot NEWROOT [COMMAND [ARG]...]
```

## Description

This command exists to say that it cannot work. Linux runs a command with a different directory as the root of the filesystem. Here every process is a worker thread in one tab, the worker boundary is the isolation, and there is one filesystem: nothing can be given a view of its own. It prints one line saying so and exits with status 1, so a script that depends on it fails where it can be seen. `--help` and `--version` answer.

Programs that need this (containers, sandboxes) cannot run on ecmaOS.

## See also

`ps`, `kill`, `mount`
