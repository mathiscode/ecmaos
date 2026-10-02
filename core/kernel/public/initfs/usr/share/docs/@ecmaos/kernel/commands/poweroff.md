# poweroff

`man @ecmaos/kernel/commands/poweroff`

## Synopsis

```
poweroff [-f]
```

## Description

Powers the system off: asks init (pid 1) to run the `shutdown` entries of `/etc/inittab`, stop every other process, then shut down the kernel. It sends `SIGUSR2` to init. Requires root.

A page cannot switch itself off. After the kernel stops, this tries to close the page, but browsers only let a script close a window that a script opened, so in an ordinary tab the kernel stops and the page stays open, as with `halt`.

`-f` skips init and stops the kernel at once.

## See also

`@ecmaos/kernel/commands/halt`, `@ecmaos/kernel/commands/reboot`, `@ecmaos/kernel/commands/init`
