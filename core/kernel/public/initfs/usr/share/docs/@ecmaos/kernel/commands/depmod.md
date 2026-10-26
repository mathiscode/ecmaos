# depmod

`man @ecmaos/kernel/commands/depmod`

## Synopsis

```
depmod
```

## Description

Reads every `NAME.ko.mjs` under `/lib/modules/RELEASE` and writes `modules.dep` and `modules.alias` there, which `modprobe` uses to load a module together with the modules it needs, and to find a module by an alias.

## Options

- `--help`: display help and exit

## Notes

Only root may run it (it needs the capability to load and unload modules).

## Exit status

0 on success, 1 on an error or an argument it does not know.

## See also

`@ecmaos/kernel/commands/modprobe`, `@ecmaos/kernel/commands/modinfo`, `@ecmaos/kernel/commands/insmod`
