# telinit

`man @ecmaos/kernel/commands/telinit`

## Synopsis

```
telinit LEVEL
```

## Description

Changes the runlevel (root only). It writes the level, one character, to `/run/runlevel` and sends `SIGHUP` to init, which reads `/etc/inittab` again: respawn entries the level leaves out are stopped, the ones it brings in are started, and `once` and `wait` entries it brings in for the first time run. `telinit q` only makes init read the file again.

Runlevels are used when `/etc/inittab` has an `initdefault` entry (`id:5:initdefault:`); without one nothing is filtered. See `man @ecmaos/coreutils/inittab`.
