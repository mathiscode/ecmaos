# uninstall

`man @ecmaos/kernel/commands/uninstall`

## Synopsis

```
uninstall <package-name>[@version]
```

## Description

Uninstalls a package previously installed with `install`. If no version is given, every installed version is removed. The links the package made in `/usr/bin` and `/usr/share` go with it; a link that another package or version made is left alone. A dependency that `install` brought in stays until it is uninstalled by name.

## See also

`@ecmaos/kernel/commands/install`
