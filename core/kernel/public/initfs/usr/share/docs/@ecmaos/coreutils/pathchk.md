# pathchk

`man @ecmaos/coreutils/pathchk`

## Synopsis

```
pathchk [-p] [-P] [--portability] NAME...
```

## Description

Check that file names are valid and portable. With no options, each NAME is checked against this system's limits: at most 255 bytes per component and 4095 for the whole name. Any directory on the way that exists must be a directory.

`-p` checks against POSIX's portable limits instead: 14-byte components, 256-byte names, and only the characters `A-Z a-z 0-9 . _ -`. `-P` checks for empty names and for components that start with `-`. `--portability` does both.

## Options

```
  -p             POSIX portable limits and characters
  -P             empty names and leading -
      --portability  -p and -P
```

## See also

`basename`
