# insmod

`man @ecmaos/kernel/commands/insmod`

## Synopsis

```
insmod [-f] FILE [NAME=VALUE]...
```

## Description

Loads the kernel module in FILE (a `NAME.ko.mjs` file) with the given parameters. It loads that file only; a module that needs another is loaded by `modprobe`, which reads the dependencies `depmod` wrote.

## Options

- `-f, --force`: load a module whose `kernel_api` does not match the kernel; the kernel is tainted `F`
- `--help`: display help and exit

## Notes

Only root may run it (it needs the capability to load and unload modules).

## Exit status

0 on success, 1 when the module could not be loaded or the command line is wrong.

## See also

`@ecmaos/kernel/commands/rmmod`, `@ecmaos/kernel/commands/modprobe`, `@ecmaos/kernel/commands/modinfo`, `@ecmaos/coreutils/lsmod`
