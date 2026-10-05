# groupmod

`man @ecmaos/kernel/commands/groupmod`

## Synopsis

```
groupmod [OPTION]... GROUP
```

## Description

Changes a group. Users in a group follow it to a new ID; files keep the group ID they have, so `chgrp` them if they should follow too.

## Options

- `-n, --new-name NEW_GROUP`: rename the group
- `-g, --gid GID`: give the group another ID

## Notes

Only root may run it.

## Exit status

0 on success, 1 when the change could not be made, 2 for a bad command line, 3 for an invalid ID.

## See also

`@ecmaos/kernel/commands/groupadd`, `@ecmaos/kernel/commands/groupdel`, `@ecmaos/coreutils/chgrp`
