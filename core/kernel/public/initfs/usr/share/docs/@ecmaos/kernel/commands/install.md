# install

`man @ecmaos/kernel/commands/install`

## Synopsis

```
install [install] [OPTION]... PACKAGE...
install remove [--autoremove] PACKAGE...
install autoremove
install list [-a] [PATTERN]
install info PACKAGE
install search TEXT...
install update
install upgrade [PACKAGE]...
install outdated [-a]
install clean
```

## Description

ecmaOS's package manager, on an npm registry. A `PACKAGE` is `NAME`, `NAME@VERSION`, `NAME@RANGE` (`^3.7.1`, `~1.0`), `NAME@TAG` (`next`), the same with a scope (`@scope/name`), or a local `.tgz` file (`./pkg-1.0.0.tgz`, `/tmp/pkg.tgz`), whose dependencies come from the registry.

Installing resolves the whole tree first, then fetches what is new a few packages at a time, then unpacks each package after its dependencies. A dependency is given a version that is already installed, or already chosen in the same run, whenever its range takes one. `peerDependencies` are installed as dependencies are, unless marked optional. An `optionalDependency` that cannot be had, or is built for another platform (its `os` or `cpu` list leaves ecmaOS out), is skipped. A dependency `install` cannot fetch (git, a path, a URL, a workspace) is skipped with a warning.

root installs for the whole system: packages go in `/usr/lib/<name>/<version>`, bins are linked into `/usr/bin`, and `share/applications`, `share/docs`, `share/licenses` and `share/man` are linked, file by file, into `/usr/share`. Anyone else installs into `~/.local/lib`, `~/.local/bin` and `~/.local/share` (`~/.local/bin` is on the `PATH` a login shell sets). `-g` and `--user` choose the scope. A bin is made executable, as npm does. Only a package named on the command line is linked; its dependencies stay in `lib` for it.

Each scope keeps a database of what it installed (`/var/lib/install/db.json`, or `~/.local/state/install/db.json`): each package's version, whether it was named or came in as a dependency, and which version of each dependency it was given. A package found on disk that the database does not know (installed before there was one) is adopted. `remove` keeps a package another one still depends on, as a dependency, with its links gone; `autoremove` removes the dependencies nothing named needs any more.

`update` refreshes the cached metadata of every installed package and says how many can be upgraded. `outdated` lists them, with the version each dependency can move to without leaving a range another package asks for, and exits 1 when there are any. `upgrade` moves packages installed by name to their latest versions, and removes the old version unless something still depends on it.

Metadata is fetched in its abbreviated form (`application/vnd.npm.install-v1+json`); `info` fetches the full document. Both metadata and tarballs are cached in `/var/cache/install` (or `~/.cache/install`), so `--offline` installs and reinstalls from what was fetched before, and a registry that cannot be reached falls back to the cached metadata. `clean` empties the cache.

## Trust

Every tarball is checked against the registry's `dist.integrity` (SHA-512 where the registry gives it, else the SHA-1 `shasum`) before it is unpacked, the cached copy included.

npm signs each version's integrity with an ECDSA P-256 key. Its public keys ship with ecmaOS, since npm's keys endpoint cannot be fetched from a browser. A package from `registry.npmjs.org` whose signature is missing or does not verify is refused, unless `--ignore-signatures` is given. Another registry's keys can be listed in `/etc/install/keys.json`, as `{ "REGISTRY URL": [{ "keyid": "...", "key": "BASE64 SPKI" }] }`; a registry with no keys known is not checked. `info` shows whether a version's signature verifies and whether it has build provenance.

A package's `ecmaos:preinstall` and `ecmaos:postinstall` scripts run with `sh -c` in the package's directory, as whoever runs `install`, only for trusted packages: ecmaOS's own scopes (`@ecmaos/*`, `@ecmaos-apps/*`), the names and `@scope/*` patterns listed one a line in `/etc/install/allow-scripts`, or any package with `--allow-scripts`. Otherwise they are skipped with a note. npm's own `preinstall`, `install` and `postinstall` scripts are for Node and never run.

A package that lists kernel modules in its `package.json` (`"ecmaos": { "modules": ["dist/NAME.ko.mjs"] }`) has them copied into `/lib/modules/RELEASE/` and indexed by `depmod`, in a system install only.

## Options

- `--registry URL` - registry to use (default: `$REGISTRY`, else `https://registry.npmjs.org`)
- `-g`, `--global` - install for the whole system, which needs root
- `--user` - install into `~/.local`, even as root
- `--reinstall` - install again a version that is already installed
- `--offline` - use only the cache
- `--allow-scripts` - run the packages' `ecmaos:` scripts
- `--ignore-signatures` - install even when the registry's signature is missing or does not verify
- `-n`, `--dry-run` - show what would be installed, upgraded or removed, and do nothing
- `--autoremove` - with `remove`, also remove the dependencies no longer needed
- `-a`, `--all` - with `list` and `outdated`, include dependencies
- `--help` - display usage and exit

`i` and `add` are `install`; `rm`, `uninstall` and `un` are `remove`; `ls` is `list`; `show` and `view` are `info`; `find` is `search`; `up` is `upgrade`. To install a package named like a command, name the command first: `install install list`.

## Examples

```
install axios
install jquery@3.7.1
install jquery@^3.7.1
install @ecmaos-apps/code @ecmaos-apps/tsc
install ./my-tool-1.0.0.tgz
install --user cowsay
install remove --autoremove @ecmaos-apps/code
install search markdown
install info react
install update && install upgrade
install @myscope/mypackage --registry http://localhost:4873
```

## Files

- `/var/lib/install/db.json`, `~/.local/state/install/db.json` - what is installed, and why
- `/var/cache/install`, `~/.cache/install` - cached metadata and tarballs
- `/etc/install/keys.json` - signing keys of registries other than npm's
- `/etc/install/allow-scripts` - packages whose scripts run without `--allow-scripts`

## See also

`@ecmaos/kernel/commands/uninstall`
