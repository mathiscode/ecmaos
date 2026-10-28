# mountpoint

`man @ecmaos/coreutils/mountpoint`

## Synopsis

```
mountpoint [-q] [--nofollow] [--show] PATH
```

## Description

Say whether `PATH` is a mount point, by looking for it in `/proc/mounts`. It prints `PATH is a mountpoint` or `PATH is not a mountpoint`.

Exit status: 0 for a mount point, 1 for a path that is not, 32 when the path cannot be examined. A symbolic link is followed unless `--nofollow`.

## Options

```
  -q, --quiet     print nothing
      --nofollow  do not follow a symbolic link
      --show      print the mount point of PATH (the resolved path) when it is one
```

`-d` and `-x` print device numbers; a mounted filesystem here has none, so they are refused.

## See also

`findmnt`, `mount`, `umount`
