# gpasswd

`man @ecmaos/kernel/commands/gpasswd`

## Synopsis

```
gpasswd [OPTION] GROUP
```

## Description

Administers the members of a group: add a user, remove one, or set the whole list.

## Options

- `-a, --add USER`: add USER to the group
- `-d, --delete USER`: remove USER from the group
- `-M, --members LIST`: make exactly these users (separated by commas) the members

## Notes

Group passwords and `newgrp` are not supported. Only root may run it.

## Exit status

0 on success, 1 when the change could not be made, 2 for a bad command line.

## See also

`@ecmaos/kernel/commands/groupadd`, `@ecmaos/kernel/commands/usermod`, `@ecmaos/coreutils/getent`
