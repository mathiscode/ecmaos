# lsblk

`man @ecmaos/coreutils/lsblk`

## Synopsis

```
lsblk [-abdfJlnPpr] [-o COLUMNS]
```

## Description

Lists the block devices, read from `/sys/block` (the disks, with their partitions beneath them) and `/proc/mounts` (where each is mounted), as a tree. The columns are `NAME`, `MAJ:MIN`, `RM`, `SIZE`, `RO`, `TYPE` and `MOUNTPOINTS`; `-o` picks others (`KNAME`, `PATH`, `MAJ`, `MIN`, `MOUNTPOINT`, `FSTYPE`). `-l` makes a list of it, `-d` leaves out the partitions, `-b` gives sizes in bytes, `-p` full paths, `-n` no header, `-f` the filesystem columns, and `-J`, `-P` and `-r` print JSON, `KEY="value"` pairs and raw lines.

A browser has no disks of its own: the filesystems ecmaOS mounts (the root in IndexedDB, folders you grant it, `/tmp`) are not block devices, so a machine with nothing registered with the kernel's block layer lists none, and `lsblk` prints only the header. A device that is registered shows as it does on Linux.

## Examples

```
lsblk
lsblk -f
lsblk -dno NAME,SIZE
lsblk -J
```

## See also

`@ecmaos/coreutils/df`, `@ecmaos/coreutils/mount`, `@ecmaos/coreutils/lsusb`

## License

MIT OR Apache-2.0.
