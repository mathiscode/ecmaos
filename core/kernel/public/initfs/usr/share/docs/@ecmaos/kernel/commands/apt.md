# apt

`man @ecmaos/kernel/commands/apt`

## Synopsis

```
apt [-y] [-s] [-q] COMMAND [PACKAGE...]
apt-get [-y] [-s] [-q] COMMAND [PACKAGE...]
apt-cache COMMAND [PACKAGE...]
```

## Description

Debian's package commands, on top of [`install`](install.md). The names are Debian's: `apt install node-semver`; `@ecmaos/package-index` (an npm package, with a copy built into ecmaOS) maps each to the npm package that provides it. The packages, the database of what was installed and why, the cache and the registry signature checks are `install`'s, so `apt install cowsay` and `install cowsay` are the same thing, and `apt list --installed` and `install list` show the same packages.

`apt` and `apt-get`: `update`, `upgrade`, `full-upgrade` / `dist-upgrade`, `install`, `reinstall`, `remove`, `purge`, `autoremove`, `autopurge`, `clean`, `autoclean`; `apt` alone also has `search`, `show`, `list`, `policy`, `depends` and `rdepends`; `apt-get` has `check`. `apt-cache`: `search`, `show`, `policy`, `depends`, `rdepends`, `pkgnames`.

`install` shows the packages that will be installed, upgraded or removed, the disk space they take, and asks `Do you want to continue? [Y/n]` unless `-y`; `-s` shows `Inst` and `Conf` lines and does nothing. Dependencies are installed as automatic and `autoremove` takes them once nothing needs them.

root installs for the whole system. Anyone else installs into `~/.local` and is told so (`N: Not running as root`); `sudo apt install ...` is the whole system.

A name the index does not know is not guessed at: `E: Unable to locate package NAME`, exit status 100, nothing installed, and the npm packages with close names are listed so one can be installed by its npm name. A name ecmaOS already ships (`curl`, `git`, `tar`...) is reported as already the newest version.

`update` fetches the latest `@ecmaos/package-index` (checking its integrity and signature), refreshes the metadata of what is installed, and says how many packages can be upgraded. If the index cannot be fetched it warns and keeps using the one it has. `list` asks the registry nothing: what it says is newer comes from the metadata `update` cached.

## Options

- `-y`, `--yes`: do not ask.
- `-s`, `--simulate`: do nothing, show what would happen.
- `-q`, `-qq`: less output, errors only.
- `--reinstall`: install a package again.
- `--installed`, `--upgradable`: with `list`.
- `--registry=URL`, `--user`, `--offline`: as for `install`.

Other apt options (`-f`, `--no-install-recommends`, `-o KEY=VALUE`...) are accepted and have nothing to do here.

## See also

[`install`](install.md), [`dpkg`](dpkg.md), [`pacman`](pacman.md), [`npm`](npm.md)
