# make

`man @ecmaos/coreutils-copyleft/make`

## Synopsis

```
make [OPTIONS] [TARGET]... [VARIABLE=VALUE]...
```

## Description

GNU make 4.4, built to WebAssembly and run as an ordinary program. It reads `Makefile` (or `makefile`, or the file
given with `-f`), works out which targets are out of date by modification time, and runs the recipes that bring them
up to date. Variables, pattern rules, automatic variables (`$@`, `$<`, `$^`), functions (`$(shell ...)`,
`$(wildcard ...)`, `$(patsubst ...)`), conditionals, `include` and `.PHONY` all work.

A recipe line is started as a child process: a simple command directly, one with shell syntax with `/bin/sh -c`. `-j`
runs jobs side by side, and a recursive `$(MAKE)` shares the jobserver, so the whole tree keeps to the one limit.

Differences from a Linux `make`:

- The jobserver is a pipe; `--jobserver-style=fifo` is not available.
- `load` (dynamic objects) and Guile are not available.

## Examples

```
make
make -n all
make -f build.mk clean
make CC=cc -B
```

## License

GNU make 4.4.1, GPL-3.0-or-later. The license text is in `/usr/share/licenses/@ecmaos/coreutils-copyleft/make/`. The source it was built from, and what ecmaOS changed, is described in `/usr/share/licenses/@ecmaos/coreutils-copyleft/make/SOURCE`; the site that served the program also serves the source archive at `/sources/`.
