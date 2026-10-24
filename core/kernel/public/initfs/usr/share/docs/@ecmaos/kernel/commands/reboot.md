# reboot

`man @ecmaos/kernel/commands/reboot`

## Synopsis

```
reboot [-f]
```

## Description

Reboots the system: asks init (pid 1) to run the `shutdown` entries of `/etc/inittab`, stop every other process, then shut down the kernel and reload the page. It does this by sending `SIGTERM` to init, so the command is stopped along with everything else. Requires root.

`-f` skips init and shuts down and reloads at once. Use it if init is stuck. It calls the `system_stop` main-thread syscall, since `kernel.reboot()` ends in `location.reload()`, which does not exist inside a Web Worker.

## See also

`@ecmaos/kernel/commands/halt`, `@ecmaos/kernel/commands/poweroff`, `@ecmaos/coreutils/init`, `@ecmaos/coreutils/ps`
