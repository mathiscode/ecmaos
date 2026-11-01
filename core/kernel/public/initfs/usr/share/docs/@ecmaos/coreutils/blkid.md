# blkid

`man @ecmaos/coreutils/blkid`

## Synopsis

```
blkid [-o format] [-s tag] [device ...]
```

## Description

Prints the type of each block device, read from `/sys/block` and `/proc/mounts` like `lsblk`. A machine with no block devices prints nothing and exits 2, as blkid does. `-o` picks `full`, `value`, `list`, `device` or `export`; `-s TYPE` limits the tags. Only `TYPE` is known: the devices carry no labels or UUIDs to read.

## Examples

```
blkid
blkid -o value /dev/vda1
```

## See also

`@ecmaos/coreutils/lsblk`, `@ecmaos/coreutils/findmnt`

## License

MIT OR Apache-2.0.
