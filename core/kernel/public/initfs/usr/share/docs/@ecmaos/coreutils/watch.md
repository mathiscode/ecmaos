# watch

`man @ecmaos/coreutils/watch`

## Synopsis

```
watch [OPTION]... COMMAND
```

## Description

Runs COMMAND again and again, clearing the screen between runs and showing a header with the interval and the time. A single word that names a program is run directly; anything else is run through `ecmash -c`, so `watch 'ls | wc -l'` works. It stops on `^C`.

## Options

- `-n, --interval=SECONDS`: seconds between runs (default 2, at least 0.1)
- `-t, --no-title`: leave out the header
- `-e, --errexit`: stop, with the command's status, when it fails
- `-g, --chgexit`: stop when the output changes

## Exit status

130 after `^C`, the command's status with `-e`, 0 with `-g`, 1 for a bad option, 127 when the command is not found.

## See also

`@ecmaos/coreutils/ps`
