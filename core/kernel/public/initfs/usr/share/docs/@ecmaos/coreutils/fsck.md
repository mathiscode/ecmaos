# fsck

`man @ecmaos/coreutils/fsck`

## Synopsis

```
fsck [-r] [-q] [DIRECTORY]
```

## Description

Check the root filesystem (or DIRECTORY) for the damage two browser tabs sharing one store leave behind, which the machine lock
now prevents. It only reports; nothing is repaired or deleted.

It finds:

- a directory entry that cannot be examined
- one inode number shared by entries that are not hard links of each other, or by entries of different kinds
- a directory reached twice
- with `--read`, a file whose data cannot be read, or is not as long as its inode says

`/proc`, `/sys`, `/dev`, `/tmp`, `/media` and `/mnt` are other filesystems and are skipped.

## Options

```
  -r, --read   also read every regular file (slow on a big machine)
  -q, --quiet  print only the problems
  --help       display this help and exit
```

Exit status: 0 when nothing is wrong, 4 when problems were found, 8 when the check could not run.

## Examples

```
fsck
fsck --read /home
```

## What to do about a problem

Copy out what you can read, then `format` the machine and put it back: a shared inode means two files wrote into one record, so
at least one of them no longer has its own content.

## See also

`df`, `format`, `ls -i`
