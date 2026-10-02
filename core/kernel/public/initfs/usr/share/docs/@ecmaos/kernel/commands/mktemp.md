# mktemp

`man @ecmaos/kernel/commands/mktemp`

## Synopsis

```
mktemp [OPTION]... [TEMPLATE]
```

## Description

Create a temporary file or directory, safely, and print its name.

## Options

```
  -d, --directory     create a directory, not a file
  -q, --quiet        suppress error messages
  -u, --dry-run      do not create anything; merely print a name (unsafe)
  -p DIR, --tmpdir=DIR  interpret TEMPLATE relative to DIR; if DIR is not
                        specified, use \$TMPDIR if set, else /tmp.
  -t                 interpret TEMPLATE relative to the directory specified by
                        -p, or \$TMPDIR if -p is not given; if neither is
                        specified, use /tmp [deprecated]
  --help             display this help and exit

The TEMPLATE must contain at least 3 consecutive 'X's in last component.
If TEMPLATE is not specified, use tmp.XXXXXX, and --tmpdir implies -t.
```

## See also

`mktemp --help`
