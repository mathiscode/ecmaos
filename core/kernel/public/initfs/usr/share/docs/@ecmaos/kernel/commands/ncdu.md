# ncdu

`man @ecmaos/kernel/commands/ncdu`

## Synopsis

```
ncdu [-0|-1|-2] [-x] [-e] [-q] [-o FILE|-f FILE] [DIR]
```

## Description

ncdu 1.22, the disk usage browser. It scans `DIR` (the current directory by default), then shows each directory sorted by size: arrow keys to move, Enter to descend, `d` to delete, `n` and `s` to sort by name or size, `?` for help, `q` to quit. `-o FILE` exports the scan as JSON instead of showing it (`-o -` for standard output) and `-f FILE` browses an export. `b` (spawn a shell) needs fork and does not work here.

## Examples

```
ncdu /usr
ncdu -o - /home | jq .
ncdu -f scan.json
```

## License

MIT (statically linked with ncurses, X11 license). The license text is in `/usr/share/licenses/@ecmaos/coreutils/ncdu/`.
