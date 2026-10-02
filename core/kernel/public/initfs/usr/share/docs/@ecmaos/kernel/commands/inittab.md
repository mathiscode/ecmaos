# inittab

`man @ecmaos/kernel/commands/inittab`

## Synopsis

```
/etc/inittab
```

## Description

The file `init` reads at boot and again on `SIGHUP` (`kill -HUP 1`). One entry per line, in BusyBox's format:

```
id:runlevels:action:command
```

- `id` is a label. It may be empty and need not be unique.
- `runlevels` is accepted and ignored.
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

A command that starts with `#!ecmaos:bin:script:` is a script for the kernel's own shell, such as `/boot/init`. Those are only allowed as `sysinit`, `wait` or `shutdown` entries, because that shell is shared with whoever is at the terminal.

BusyBox's `ctrlaltdel`, `askfirst`, `respawnask` and `restart` actions are not supported, and a line using one is skipped with a message.

## Default

```
::sysinit:/boot/init
::respawn:/bin/crond
```

If the file is missing, init uses this.

## See also

`@ecmaos/kernel/commands/init`
