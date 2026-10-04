# chgrp

`man @ecmaos/kernel/commands/chgrp`

## Synopsis

```
chgrp [OPTION]... GROUP FILE...
chgrp [OPTION]... --reference=RFILE FILE...
```

## Description

Changes the group of each FILE to GROUP, a name from `/etc/group` or a number, and leaves the owner as it is.

## Options

- `-R, --recursive`: operate on files and directories recursively
- `-v, --verbose`: say what is done for every file
- `-c, --changes`: like `-v`, but only when a change is made
- `-f, --silent, --quiet`: suppress most error messages
- `--reference=RFILE`: use RFILE's group

## Notes

Like `chown -R`, changing the ownership of a directory from a program needs a newer `@zenfs/core` than the published 2.7.6; where that is missing the directory is reported and the rest carry on.

## Exit status

0, or 1 when a file could not be changed.

## See also

`@ecmaos/kernel/commands/chown`, `@ecmaos/kernel/commands/chmod`, `@ecmaos/kernel/commands/getent`
