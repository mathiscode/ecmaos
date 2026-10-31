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
install hold PACKAGE...
install unhold PACKAGE...
install rollback PACKAGE
install clean
```

## Description

ecmaOS's package manager, on an npm registry. A `PACKAGE` is `NAME`, `NAME@VERSION`, `NAME@RANGE` (`^3.7.1`, `~1.0`), `NAME@TAG` (`next`), the same with a scope (`@scope/name`), or a local `.tgz` file (`./pkg-1.0.0.tgz`, `/tmp/pkg.tgz`), whose dependencies come from the registry.

Installing resolves the whole tree first, then fetches what is new a few packages at a time, then unpacks each package after its dependencies. A dependency is given a version that is already installed, or already chosen in the same run, whenever its range takes one. `peerDependencies` are installed as dependencies are, unless marked optional. An `optionalDependency` that cannot be had, or is built for another platform (its `os` or `cpu` list leaves ecmaOS out), is skipped. A dependency `install` cannot fetch (git, a path, a URL, a workspace) is skipped with a warning.

root installs for the whole system: packages go in `/usr/lib/<name>/<version>`, bins are linked into `/usr/bin`, and `share/applications`, `share/docs`, `share/licenses` and `share/man` are linked, file by file, into `/usr/share`. Anyone else installs into `~/.local/lib`, `~/.local/bin` and `~/.local/share` (`~/.local/bin` is on the `PATH` a login shell sets). `-g` and `--user` choose the scope. A bin is made executable, as npm does. Only a package named on the command line is linked; its dependencies stay in `lib` for it.

Each scope keeps a database of what it installed (`/var/lib/install/db.json`, or `~/.local/state/install/db.json`): each package's version, whether it was named or came in as a dependency, and which version of each dependency it was given. A package found on disk that the database does not know (installed before there was one) is adopted. `remove` keeps a package another one still depends on, as a dependency, with its links gone; `autoremove` removes the dependencies nothing named needs any more.

`update` refreshes the cached metadata of every installed package and says how many can be upgraded. `outdated` lists them, with the version each dependency can move to without leaving a range another package asks for, and exits 1 when there are any. `upgrade` moves packages installed by name to their latest versions, and removes the old version unless something still depends on it.

Metadata is fetched in its abbreviated form (`application/vnd.npm.install-v1+json`); `info` fetches the full document. Both metadata and tarballs are cached in `/var/cache/install` (or `~/.cache/install`), so `--offline` installs and reinstalls from what was fetched before, and a registry that cannot be reached falls back to the cached metadata. `clean` empties the cache.

## Running what is installed

A package's `bin` runs as a command: `install cowsay && cowsay hi`. The package's dependencies are linked into its `node_modules` (`/usr/lib/NAME/VERSION/node_modules/DEP` is a link to the version it was given), so a program that `require`s or `import`s them finds those versions; `/bin/node` resolves as Node does, runs CommonJS and ES modules, and provides Node's own modules (`fs`, `path`, `child_process`, `http` clients, and the rest) over the kernel's syscalls. A script of your own finds the packages installed system-wide too: `node script.js` with `require('semver')` uses the highest installed version.

## Other package managers

`apt`, `apt-get`, `apt-cache`, `dpkg`, `pacman`, `npm`, `npx`, `yarn` and `pnpm` are front-ends of this command (`pip` is its own, on PyPI): the same packages, database and cache under their own commands and output (see their pages). The distribution tools use their own names for packages, which `@ecmaos/package-index` maps to npm packages; `apt update` and `pacman -Sy` fetch its latest version and keep it in `/var/lib/install/package-index.json` (or `~/.local/state/install/package-index.json`), and the copy built into ecmaOS is used until then.

## Groups and relations

A group is a package with `"ecmaos": { "meta": true }` and nothing but `dependencies` (the programs ecmaOS ships are grouped as `@ecmaos-apps/group-compression`, `group-editors` and so on, and the profiles `profile-minimal`, `profile-standard`, `profile-developer` and `profile-everything` are groups of groups). A group's members are ranged on the dist-tag `latest`, since every program's version is a prerelease (`X.Y.Z-ecmaos.N`) that `*` would not take. Installing a group links the commands of its members, which stay automatic installs: removing the group and running `install autoremove` takes them. `install upgrade` upgrades the members, and a group's upgrade never brings back a member taken out on purpose.

`install remove vim` while a group wants it removes `vim`, leaves the group installed and puts `vim` on `/etc/ecmaos/profile.d/excluded.json`; installing it by name takes it off again, and a group install or upgrade skips what is on the list.

A package can also say, under `ecmaos`: `recommends` (installed with it unless `--no-install-recommends`; one that cannot be had is skipped), `suggests` (printed, never installed), `conflicts` (the install is refused beside these), `replaces` (an installed package of one of these names goes when this one is installed: a rename) `link` (names of its dependencies whose commands it wants on the PATH, as a group's members have: `@ecmaos-apps/pip` lists `@ecmaos-apps/python3`, so installing pip puts `python3` there too, while a plain dependency stays a library) and `requires`, `{ "kernel": ">=1.0.0", "features": ["wasi"] }`, which refuses a package this kernel cannot run (`--force` installs it anyway). The registry's document is read for these: ecmaOS's own scopes and any registry other than npm's are fetched whole, since npm's abbreviated document leaves `ecmaos` out.

`install hold NAME` keeps a package at its version: `upgrade` leaves it and `install NAME` does not move it (a version asked for does); `unhold` lets it move. An upgrade keeps the version it replaced for one rollback: `install rollback NAME` goes back to it and keeps the newer one, so a second rollback goes forward again.

## Programs as packages

A WebAssembly program is an npm package in the `@ecmaos-apps` scope: `install -g @ecmaos-apps/figlet` (or `apt install figlet`) links `figlet.wasm` into `/usr/bin` as any package's bin. A program that needs files beside it (`figlet`'s fonts, `vim`'s runtime) ships them under `"ecmaos": { "runtime": "runtime" }`, laid out from `/`; its `usr/` is linked into `/usr` file by file and unlinked when the package is removed, so only a system install puts them in place (a `--user` install says so). `utils/apps-packages.mjs` writes these packages from the programs of `@ecmaos/coreutils` and `@ecmaos/coreutils-copyleft` (`build OUT [name...]`), and `index` adds the names to `@ecmaos/package-index`.

A program moves out of the boot catalog when its `programs/manifest.json` entry gains `"package": "@ecmaos-apps/NAME"`: the site stops serving it, and a machine that had it from the catalog loses that copy at the next boot and is told to install the package. Programs not moved are still written to `/bin` at boot.

A package's version is the program's upstream version and ecmaOS's revision of the build, `9.1.0-ecmaos.2`. A copyleft program's package names its source package (`"ecmaos": { "source": "@ecmaos-apps/NAME-src@VERSION" }`), published with it at the same version: `install` says so when it links the program, and `apt source NAME` (or `install @ecmaos-apps/NAME-src`) brings the upstream archives, our patches, the build recipe and the toolchain's pins. The generator refuses a copyleft program whose source it cannot assemble.

To try packages before anything is published, `node utils/apps-registry.mjs up` starts a local registry (Verdaccio, `http://localhost:4893`, kept in `.registry/`), `publish [name...]` builds the packages and publishes them there, and `REGISTRY=http://localhost:4893` (or `--registry`) points ecmaOS at it. Nothing in it goes to npmjs.

## Trust

Packages of `@ecmaos-apps` are also checked against a signed index. `@ecmaos/package-index` carries `trust.json` (every package the project published, with its versions' integrity and which one is `latest`) and `trust.sig.json` (an Ed25519 signature of it, and the key's id); `apt update` fetches them. `install` refuses a package of the scope that is not in the index, whose integrity differs from it, or whose `latest` is not the one the index names, and refuses everything in the scope when the index is missing or signed with a key not in `/etc/ecmaos/trusted-keys.json`, `[{ "keyId", "key" (base64, the 32 raw bytes), "notAfter"? }]`; a key past its `notAfter` is not trusted, so keys can be rotated. `--allow-unsigned` skips the check, for a registry of your own. `node utils/apps-sign.mjs` makes the key and signs; where the private key lives is the publisher's.

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
- `--allow-unsigned` - install packages of `@ecmaos-apps` that are not in the signed index
- `--no-install-recommends` - do not install what a package recommends
- `--force` - install a package even when it needs a newer kernel than this one
- `--hold`, `--unhold`, `--rollback` - the same as the `hold`, `unhold` and `rollback` commands
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
- `/etc/ecmaos/sources.d/*.json` - registries by scope: `{ "name", "registry", "scopes": ["@scope"], "priority" }`; a scope goes to the highest-priority source that lists it, anything else to the default registry (`--registry` overrides them all)
- `/etc/ecmaos/trusted-keys.json` - the project keys the signed index is checked with
- `/etc/ecmaos/profile.d/excluded.json`, `~/.config/ecmaos/excluded.json` - group members taken out on purpose

## See also

`@ecmaos/kernel/commands/uninstall`
