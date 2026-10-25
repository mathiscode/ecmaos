# install

`man @ecmaos/kernel/commands/install`

## Synopsis

```
install <package-name>[@version] [--registry URL] [--reinstall]
```

## Description

Installs an npm package from a registry into `/usr/lib/<name>/<version>` and links its bin(s) into `/usr/bin`, making them runnable as ordinary commands. A bin is made executable, as npm does. Supports scoped packages (`@scope/name`), pinned/range/`latest` version specifiers, and a custom registry (e.g. a local [Verdaccio](https://github.com/verdaccio/verdaccio) server for app development).

The tarball is checked against the registry's `dist.integrity` (SHA-512 where the registry gives it) before it is unpacked; a registry that gives only the SHA-1 `shasum` is checked against that.

A package's `share/applications`, `share/docs`, `share/licenses` and `share/man` are linked, file by file, into the same places under `/usr/share`, beside what other packages put there (`man @scope/name/command` reads the `docs` a package ships).

The package's `dependencies` are installed too, but only the package you named is linked: a dependency's bins and `share/` files stay in `/usr/lib` for the package that needs it. Installing a dependency by name afterwards links it. The package's `ecmaos:preinstall` and `ecmaos:postinstall` scripts run as shell commands.

## Options

- `--registry URL` - registry to use (default: `$REGISTRY`, else `https://registry.npmjs.org`)
- `--reinstall` - remove an already-installed copy first
- `--help` - display usage and exit

## Examples

```
install axios
install jquery@3.7.1
install jquery@^3.7.1
install @ecmaos-apps/code
install @ecmaos-apps/tsc
install @myscope/mypackage --registry http://localhost:4873
```

## See also

`@ecmaos/kernel/commands/uninstall`
