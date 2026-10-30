# dpkg

`man @ecmaos/kernel/commands/dpkg`

## Synopsis

```
dpkg -l [PATTERN...]        dpkg -L PACKAGE...      dpkg -s PACKAGE...
dpkg -S PATH...             dpkg -W [PATTERN...]    dpkg --get-selections
dpkg -i FILE.tgz...         dpkg -r PACKAGE...      dpkg -P PACKAGE...
```

## Description

Debian's low-level package tool, over [`install`](install.md)'s database. Packages are shown by their Debian names where the index (`@ecmaos/package-index`) has one, else by their npm names.

- `-l` lists installed packages in `dpkg`'s table (`ii  NAME  VERSION  all  DESCRIPTION`); a pattern may use `*`.
- `-s` shows a package's status: `Package`, `Status: install ok installed`, `Installed-Size`, `Version`, `Depends`, `Description`, and `Auto-Installed: yes` for a dependency.
- `-L` lists the files a package put in place (its files in `lib`, the bins and the `share/` files linked from it); `-S` finds the package a file belongs to, following links.
- `-W` prints `NAME<TAB>VERSION`; `--get-selections` prints `NAME install`.
- `-i` installs a local npm tarball (`.tgz`); its dependencies come from the registry. A `.deb` is refused: a package here is an npm tarball.
- `-r` and `-P` remove packages (the same here: there are no configuration files to purge).

root works on the whole system, anyone else on `~/.local`; `--user` picks it for root too.

## See also

[`apt`](apt.md), [`install`](install.md)
