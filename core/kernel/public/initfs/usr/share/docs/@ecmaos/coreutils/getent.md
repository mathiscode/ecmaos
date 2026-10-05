# getent

`man @ecmaos/coreutils/getent`

## Synopsis

```
getent DATABASE [KEY]...
```

## Description

Prints entries of an account database, `passwd` or `group`, that match each KEY (a name or a number), or all of them when there is no KEY. It reads `/etc/passwd` and `/etc/group`.

## Exit status

0 when everything asked for was found, 1 for a bad command line, 2 when a key was not found, 3 when the database cannot be read.

## See also

`@ecmaos/coreutils/id`, `@ecmaos/coreutils/chgrp`
