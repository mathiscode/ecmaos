# groupadd

`man @ecmaos/kernel/commands/groupadd`

## Synopsis

```
groupadd [OPTION]... GROUP
```

## Description

Creates a group in `/etc/group`. The group ID is the first free one from 1000, or from 100 to 999 for a system group (`-r`).

## Options

- `-g, --gid GID`: the group ID
- `-r, --system`: a system group
- `-f, --force`: succeed, doing nothing, if the group already exists

## Notes

Only root may run it.

## Exit status

0 on success, 1 when the group could not be created, 2 for a bad command line, 3 for an invalid ID.

## See also

`@ecmaos/kernel/commands/groupdel`, `@ecmaos/kernel/commands/groupmod`, `@ecmaos/kernel/commands/gpasswd`, `@ecmaos/kernel/commands/useradd`
