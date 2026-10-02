# halt

`man @ecmaos/kernel/commands/halt`

## Synopsis

```
halt [-f]
```

## Description

Halts the system: asks init (pid 1) to run the `shutdown` entries of `/etc/inittab`, stop every other process, then shut down the kernel. The page is not reloaded. It does this by sending `SIGUSR1` to init. Requires root.

`-f` skips init and stops the kernel at once.

## See also

`@ecmaos/kernel/commands/reboot`, `@ecmaos/kernel/commands/poweroff`, `@ecmaos/kernel/commands/init`
