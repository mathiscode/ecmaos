# halt

`man @ecmaos/kernel/commands/halt`

## Synopsis

```
halt [-f]
shutdown [-h] now
```

## Description

Halts the system: asks init (pid 1) to run the `shutdown` entries of `/etc/inittab`, stop every other process, then shut down the kernel. The page is not reloaded. It does this by sending `SIGUSR1` to init. Requires root.

`-f` skips init and stops the kernel at once.

`/bin/shutdown` is a link to `halt`; the `-h` and `now` of `shutdown -h now` are accepted and change nothing.

## See also

`@ecmaos/kernel/commands/reboot`, `@ecmaos/kernel/commands/poweroff`, `@ecmaos/coreutils/init`
