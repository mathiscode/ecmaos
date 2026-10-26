# rmmod

`man @ecmaos/kernel/commands/rmmod`

## Synopsis

```
rmmod [-f] NAME...
```

## Description

Unloads kernel modules. A name may be written with its `.ko.mjs` ending. A module that something else uses is refused unless `-f` is given.

## Options

- `-f, --force`: unload a module that is still in use; the kernel is tainted `F`
- `--help`: display help and exit

## Notes

Only root may run it (it needs the capability to load and unload modules).

## Exit status

0 when every module was unloaded, 1 when one could not be or the command line is wrong.

## See also

`@ecmaos/kernel/commands/insmod`, `@ecmaos/kernel/commands/modprobe`, `@ecmaos/coreutils/lsmod`
