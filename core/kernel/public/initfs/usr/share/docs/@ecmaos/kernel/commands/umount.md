# umount

`man @ecmaos/kernel/commands/umount`

## Synopsis

```
umount [OPTIONS] TARGET
umount [-a|--all]
```

## Description

Unmount a filesystem.

## Options

```
Options:
  -a, --all    unmount all filesystems (except root)
  --help       display this help and exit

Examples:
  umount /mnt/tmp        unmount filesystem at /mnt/tmp
  umount -a              unmount all filesystems
```

## Permissions

Only root may unmount a filesystem.

## See also

`umount --help`
