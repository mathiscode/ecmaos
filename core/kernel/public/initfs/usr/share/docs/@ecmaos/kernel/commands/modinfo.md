# modinfo

`man @ecmaos/kernel/commands/modinfo`

## Synopsis

```
modinfo FILE|NAME...
```

## Description

Shows what a kernel module says about itself, without running it. The argument is a `NAME.ko.mjs` or `NAME.ko.wasm` file, a module that is loaded, or the name or an alias of one installed in `/lib/modules/RELEASE`. A signed module's signature is checked.

## Options

- `--help`: display help and exit

## Exit status

0 when every module was described, 1 when one was not found or the command line is wrong.

## See also

`@ecmaos/kernel/commands/insmod`, `@ecmaos/kernel/commands/modprobe`, `@ecmaos/kernel/commands/sign-module`, `@ecmaos/coreutils/lsmod`
