# install

`man @ecmaos/kernel/commands/install`

## Synopsis

```
install <package-name>[@version] [--registry URL] [--reinstall]
```

## Description

Installs an npm package from a registry into `/usr/lib` and links its bin(s) into `/usr/bin`, making them runnable as ordinary commands. Supports scoped packages (`@scope/name`), pinned/range/`latest` version specifiers, and a custom registry (e.g. a local [Verdaccio](https://github.com/verdaccio/verdaccio) server for app development).

## Options

- `--registry URL` -- registry to use (default: `$REGISTRY`, else `https://registry.npmjs.org`)
- `--reinstall` -- remove an already-installed copy first
- `--help` -- display usage and exit

## Examples

```
install axios
install jquery@3.7.1
install jquery@^3.7.1
install @ecmaos-apps/code
install @myscope/mypackage --registry http://localhost:4873
```

## See also

`@ecmaos/kernel/commands/uninstall`
