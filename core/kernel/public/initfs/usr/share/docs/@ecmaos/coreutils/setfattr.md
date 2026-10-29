# setfattr

`man @ecmaos/coreutils/setfattr`

## Synopsis

```
setfattr {-n NAME} [-v VALUE] [-h] FILE...
setfattr {-x NAME} [-h] FILE...
setfattr [-h] --restore=FILE
```

## Description

Set or remove an extended attribute of files, as the attr package's `setfattr` does. `-n NAME -v VALUE` sets it (with no `-v` the value is empty), and `-x NAME` removes it. A value that begins with `0x` is hex, one that begins with `0s` is base64, one in double quotes may use `\` escapes (`\012` for a newline), and anything else is taken as it is. `-h` acts on a symbolic link itself rather than what it points to.

`--restore=FILE` puts back what `getfattr -d` wrote: each `# file:` block's attributes on that file, relative paths taken from the current directory. `-` reads the dump from standard input.

Names must be in the `user.` namespace; others are refused with `Operation not supported`.

## Examples

```
setfattr -n user.comment -v "first draft" notes.txt
setfattr -n user.hash -v 0x00ff10 notes.txt
setfattr -x user.comment notes.txt
getfattr -R -d /srv > /tmp/attrs.dump; cd / && setfattr --restore=/tmp/attrs.dump
```

## See also

`getfattr`, `chattr`
