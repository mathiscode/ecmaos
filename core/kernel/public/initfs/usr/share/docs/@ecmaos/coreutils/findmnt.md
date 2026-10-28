# findmnt

`man @ecmaos/coreutils/findmnt`

## Synopsis

```
findmnt [options] [DEVICE | MOUNTPOINT]
findmnt [options] [-S SOURCE] [-T PATH | -M DIR]
```

## Description

List the mounted filesystems, or find one. The table is `/proc/mounts`; a filesystem here has no device, so its source is its type (`tmpfs`, `proc`, ...). With no argument every mount is listed, in table order.

A lone operand matches a mount point or a source. `-T PATH` finds the mount that holds a path (the longest mount point that is a parent of it), as `df PATH` does. The exit status is 1 when nothing matches.

## Options

```
  -f, --first-only       print the first match only
  -i, --invert           invert the sense of matching
  -J, --json             JSON output
  -l, --list             list format (the default; there is no tree)
  -M, --mountpoint DIR   the mount point
  -n, --noheadings       no heading line
  -O, --options LIST     only mounts with all of these options
  -o, --output LIST      columns: TARGET, SOURCE, FSTYPE, OPTIONS
  -P, --pairs            KEY="value" output
  -r, --raw              raw output, spaces escaped as \x20
  -S, --source STRING    the source
  -T, --target PATH      the mount that holds PATH
  -t, --types LIST       only these filesystem types; a leading `no` negates the list
```

## Examples

```
findmnt
findmnt -n -o FSTYPE -T /home
findmnt -t tmpfs
```

## See also

`mount`, `mountpoint`, `df`, `/proc/mounts`
