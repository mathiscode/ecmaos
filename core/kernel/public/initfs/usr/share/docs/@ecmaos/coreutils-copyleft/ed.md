# ed

`man @ecmaos/coreutils-copyleft/ed`

## Synopsis

```
ed [-GElrsv] [-p STRING] [FILE]
```

## Description

GNU ed 1.22.5, the standard line editor. It reads commands from the terminal, or from a script on standard input, and edits one buffer: `a`, `i` and `c` add text (ended by a line holding only `.`), `p`, `n` and `l` print, `d` deletes, `s/re/new/g` substitutes, `g/re/cmd` runs a command on every matching line, `r FILE` reads a file in, `w` writes and `q` quits (`Q` quits without the warning about unsaved changes). Addresses are line numbers, `.` and `$`, `/re/` searches, and `,` is the whole buffer. `-s` suppresses the byte counts and the `!` printed after a shell command, which is what a script wants, and `-p STRING` sets a prompt. `!command` runs a shell command.

A command it cannot carry out prints `?`; `h` explains the last one, and `H` turns on explanations for all of them.

## Examples

```
ed notes.txt
printf '%%s/foo/bar/g\nw\nq\n' | ed -s notes.txt
printf '$r more.txt\nw\nq\n' | ed -s notes.txt
```

## License

GPL-2.0-or-later. The license text and the source offer are in `/usr/share/licenses/@ecmaos/coreutils-copyleft/ed/`.
