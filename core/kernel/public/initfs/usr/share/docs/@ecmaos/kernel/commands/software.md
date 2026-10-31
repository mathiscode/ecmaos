# software

`man @ecmaos/kernel/commands/software`

## Synopsis

```
software [list [CATEGORY|COLLECTION]]
software installed
software updates
software search [--npm] TEXT
software show NAME
software gui
```

## Description

`software` finds and inspects software; it is the text form of the Software window and the source of what the window shows (`--json` prints that data). Installing and removing stay with `install` (`install NAME`, or `sudo install -g NAME` for everyone), which the window runs as well.

- `list` shows the collections of programs by category (System, Utilities, Development and so on) with how many of each are installed; `list CATEGORY` or `list COLLECTION` shows the members, marking the installed ones with `*`.
- `installed` splits what is installed into what was asked for by name, collections, and what came as a dependency.
- `updates` asks the registry which installed packages have a newer version.
- `search TEXT` looks through the index by name and description. `--npm` also asks the registry, under a heading that says those results are not curated by ecmaOS; anyone can publish to npm.
- `show NAME` gives the version, size, license, homepage, dependencies, the collections and profiles the program is in, and for a copyleft program the source package (`apt source NAME`). A program that needs files under `/usr` (vim, python3) says it can only be installed for everyone.
- `gui` opens the Software window, which is the package `@ecmaos-apps/software`.

`--offline` leaves the registry alone and `--registry URL` picks another.

## See also

`install(1)`, `profile(1)`, `command-not-found(1)`
