# init

`man @ecmaos/kernel/commands/init`

## Synopsis

```
/sbin/init
```

## Description

`/sbin/init` is pid 1, the first process. The kernel starts it during boot and it never exits. It is not run by hand: it refuses to start unless it is pid 1.

It reads `/etc/inittab` (see `man @ecmaos/kernel/commands/inittab`) and:

1. runs every `sysinit` entry, one at a time, waiting for each;
2. runs every `wait` entry the same way;
3. tells the kernel boot has finished, so the prompt can appear;
4. starts every `once` entry and every `respawn` entry.

After that it waits for children to exit. A `respawn` entry that exits is started again, after a delay that doubles from one second up to a minute for a service that keeps dying; a service that ran for half a minute or more is restarted at once. Every other child that exits is reaped, so no zombies are left behind. Processes whose parent exits are handed to init, as on Linux.

Every process the kernel starts is a child of init, so `$PPID` in the shell is 1.

## Signals

pid 1 ignores every signal it has not asked to catch. `kill -9 1` and `^C` do nothing to it. It catches:

| Signal | Effect |
|---|---|
| `SIGHUP` | read `/etc/inittab` again. A new `respawn` entry is started; one that was removed is no longer restarted, but is not killed |
| `SIGTERM` | reboot |
| `SIGUSR1` | halt |
| `SIGUSR2` | power off |

Going down runs the `shutdown` entries in order (each may take ten seconds), sends `SIGTERM` to every other process, waits up to three seconds, sends `SIGKILL` to what is left, then stops the kernel. A reboot reloads the page; halt and power off only stop the kernel, since a page cannot switch itself off. Only root may signal init.

The `reboot`, `halt` and `poweroff` commands send these signals. The keyboard shortcut Ctrl+Shift+Delete asks init to reboot the same way.

## See also

`@ecmaos/kernel/commands/inittab`, `@ecmaos/kernel/commands/reboot`, `@ecmaos/kernel/commands/halt`, `@ecmaos/kernel/commands/poweroff`, `@ecmaos/kernel/commands/ps`
