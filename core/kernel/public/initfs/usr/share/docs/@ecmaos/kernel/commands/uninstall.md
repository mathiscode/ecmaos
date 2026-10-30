# uninstall

`man @ecmaos/kernel/commands/uninstall`

## Synopsis

```
uninstall [-g|--user] [--autoremove] <package-name>[@version]...
```

## Description

Uninstalls packages installed with `install`; it is `install remove`. If no version is given, every installed version is removed. The links the package made in `bin` and `share` go with it; a link that another package or version made is left alone. A package another installed package still depends on keeps its files and becomes a dependency, and `install autoremove` removes it once nothing needs it. With `--autoremove`, the dependencies nothing needs any more are removed at once.

root removes from the whole system (`/usr/lib`), anyone else from `~/.local`; `-g` and `--user` choose.

## See also

`@ecmaos/kernel/commands/install`
