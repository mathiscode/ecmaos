# inittab

`man @ecmaos/coreutils/inittab`

## Synopsis

```
/etc/inittab
```

## Description

The file `init` reads at boot and again on `SIGHUP` (`kill -HUP 1`). One entry per line, in BusyBox's format:

```
id:runlevels:action:command
```

- `id` is a label. It may be empty and need not be unique. An id of the form `ttyN` (0 to 7) makes init run the command with that terminal as its controlling terminal, as BusyBox does; that is how `getty` is started.
- `runlevels` lists the runlevels the entry belongs to, one character each; empty means every level. It only matters once a level is set (see Runlevels).
- `action` says when and how the command runs.
- `command` is everything after the third colon, so it may contain colons. It is split into words; single and double quotes group words, and a backslash escapes the next character. There is no shell syntax (no pipes, redirections or variables); put those in a script and run the script.

Blank lines and lines starting with `#` are ignored. A line that cannot be used is reported in the kernel log with its line number and skipped; it never stops the rest of the file from being read.

## Actions

| Action | Meaning |
|---|---|
| `sysinit` | run once, in file order, and wait for it, before anything else |
| `wait` | run once after the `sysinit` entries, and wait for it |
| `once` | start once and do not wait |
| `respawn` | start, and start again whenever it exits |
| `shutdown` | run, in file order, when the system goes down |
| `initdefault` | the `runlevels` field is the level init starts in; there is no command (`id:5:initdefault:`) |

A command that starts with `#!ecmaos:bin:script:` is a script for the kernel's own shell, such as `/boot/init`. Those are only allowed as `sysinit`, `wait` or `shutdown` entries, because that shell is shared with whoever is at the terminal.

BusyBox's `ctrlaltdel`, `askfirst`, `respawnask` and `restart` actions are not supported, and a line using one is skipped with a message.

## Runlevels

Nothing is filtered until the file has an `initdefault` entry or `telinit` has set a level. After that an entry runs only when its `runlevels` field is empty or lists the current level; `shutdown` entries run whatever the level. `telinit N` writes the level to `/run/runlevel` and makes init read the file again: `respawn` entries the level leaves out are sent `SIGTERM` and not restarted, the ones it brings in are started, and `wait` and `once` entries it brings in for the first time run. `runlevel` prints the level. The level set by `telinit` lasts for the boot: `/run` is not kept, so the next boot starts in the `initdefault` level.

```
x:5:initdefault:
tty1:12345:respawn:/sbin/getty tty1
::respawn:/bin/crond
```

## Default

```
::sysinit:/boot/init
::respawn:/bin/crond
```

If the file is missing, init uses this.

The kernel writes the file at boot when it is missing. Unless it was started with credentials, it also has a login prompt on each of the eight terminals:

```
tty0::respawn:/sbin/getty tty0
tty1::respawn:/sbin/getty tty1
...
tty7::respawn:/sbin/getty tty7
```

An untouched default file from an earlier release gains these lines at boot; a file you have edited is left alone. Remove them (and `kill -HUP 1`) to go without a prompt on a terminal, or delete them all to have the kernel prompt on the first terminal itself (keep a comment line, so the file no longer matches the old default, which would get the entries back).

## See also

`@ecmaos/coreutils/getty`, `@ecmaos/coreutils/init`
