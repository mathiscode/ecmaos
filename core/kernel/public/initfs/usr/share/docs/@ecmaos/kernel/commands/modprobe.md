# modprobe

`man @ecmaos/kernel/commands/modprobe`

## Synopsis

```
modprobe [-nvr] [--ignore-install] NAME [NAME=VALUE]...
```

## Description

Loads the module NAME (or an alias of one) from `/lib/modules/RELEASE` together with the modules it depends on, using the options in `/etc/modprobe.d`. With `-r` it unloads the module, and the modules it needed that nothing else holds.

## Options

- `-n, --dry-run`: print what would be done and do nothing
- `-v, --verbose`: print what is done
- `-r, --remove`: unload instead of load
- `--ignore-install`: do not run the `install` or `remove` command that `modprobe.d` gives for NAME
- `--help`: display help and exit

## Notes

Only root may run it (it needs the capability to load and unload modules). Run `depmod` after adding a module, so its dependencies and aliases are known.

## Exit status

0 on success, 1 on an error.

## See also

`@ecmaos/kernel/commands/depmod`, `@ecmaos/kernel/commands/insmod`, `@ecmaos/kernel/commands/rmmod`, `@ecmaos/kernel/commands/modinfo`
