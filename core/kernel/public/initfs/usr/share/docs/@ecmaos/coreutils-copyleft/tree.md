# tree

`man @ecmaos/coreutils-copyleft/tree`

## Synopsis

```
tree [OPTIONS] [DIRECTORY]...
```

## Description

`tree` 2.2, the recursive directory lister, built to WebAssembly and run as an ordinary program. It prints the
directory (the current one by default) as an indented tree, then a count of directories and files; the starting
directory is counted as one.

## Options

`-a` include hidden files, `-d` directories only, `-L N` descend at most N levels, `-f` full path prefix, `-i` no
indentation lines, `-s` sizes, `-h` human-readable sizes, `-p` permissions, `-u` and `-g` owner and group,
`-D` modification time, `-P PATTERN` only files that match, `-I PATTERN` leave files out, `--prune` drop empty
directories, `--dirsfirst`, `-r` reverse the sort, `-t` sort by time, `-C` and `-n` force and forbid colour,
`--charset=ascii` plain lines instead of box drawing, `-J` JSON, `-X` XML and `-H` HTML output, and the rest of
`tree --help`.

## Examples

```
tree
tree -L 2 /usr
tree -a --dirsfirst ~
tree -P '*.md' --prune /usr/share/docs
```

## License

tree 2.2.1, GPL-2.0-or-later. The license text is in `/usr/share/licenses/@ecmaos/coreutils-copyleft/tree/`. The source it was built from, and what ecmaOS changed, is described in `/usr/share/licenses/@ecmaos/coreutils-copyleft/tree/SOURCE`; the site that served the program also serves the source archive at `/sources/`.
