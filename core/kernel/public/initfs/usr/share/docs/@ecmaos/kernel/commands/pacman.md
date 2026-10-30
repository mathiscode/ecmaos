# pacman

`man @ecmaos/kernel/commands/pacman`

## Synopsis

```
pacman -S [--needed] [--noconfirm] PACKAGE...    pacman -Sy[u]       pacman -Su
pacman -Ss REGEX    pacman -Si PACKAGE    pacman -Sl    pacman -Sc
pacman -R[s] PACKAGE...
pacman -Q[e|d|t|q] [PACKAGE...]   pacman -Qi|-Ql PACKAGE   pacman -Qo PATH   pacman -Qs REGEX   pacman -Qu
pacman -U FILE.tgz...
```

## Description

Arch's package manager, over [`install`](install.md). Names are Arch's where the index (`@ecmaos/package-index`) knows them. Output follows pacman's: `resolving dependencies...`, `Packages (2) a-1.0  b-2.0`, `Total Installed Size:`, `:: Proceed with installation? [Y/n]`, `(1/2) installing a`.

- `-S` installs; a package that is installed is installed again (`warning: ... is up to date -- reinstalling`) unless `--needed`. `-Sy` fetches the latest package index and the metadata of installed packages; `-Syu` then upgrades the packages installed by name; `-Ss` searches the index and npm; `-Si` shows a package's details; `-Sl` lists the index; `-Sc` empties the download cache.
- `-R` removes; `-Rs` also removes the dependencies nothing else needs.
- `-Q` lists installed packages: `-Qe` those installed by name, `-Qd` the dependencies, `-Qdt` the dependencies nothing needs, `-Qq` only names, `-Qi` details, `-Ql` files, `-Qo PATH` the owner of a file, `-Qs` a search among them, `-Qu` the ones with newer versions (from what `-Sy` cached).
- `-U` installs a local npm tarball.

A name nothing knows gives `error: target not found: NAME`, and a `hint:` for npm packages with close names. `-F`, `-D` and `-T` are not there. root works on the whole system, anyone else on `~/.local`.

## See also

[`apt`](apt.md), [`install`](install.md)
