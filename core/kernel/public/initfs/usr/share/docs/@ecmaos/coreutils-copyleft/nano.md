# nano

`man @ecmaos/coreutils-copyleft/nano`

## Synopsis

```
nano [OPTIONS] [[+LINE[,COLUMN]] FILE]...
```

## Description

GNU nano 9.2, the small modeless text editor, built to WebAssembly and run as an ordinary program. It takes the
keyboard in raw mode, draws with ncurses on the terminal and follows the terminal's size.

The shortcuts are listed along the bottom of the screen (`^` is Ctrl, `M-` is Alt): `^O` writes the file, `^X`
exits, `^W` searches, `^\` replaces, `^K` and `^U` cut and paste a line, `^G` shows the help, `^_` goes to a line,
`M-U` and `M-E` undo and redo, `M-A` starts a selection. Options such as `-l` (line numbers), `-m` (mouse),
`-i` (auto-indent), `-w` (no wrapping) and `-S` (smooth scrolling) work as usual.

`^T` runs a shell command (with `/bin/sh`) and inserts what it prints; a command that starts with `|` filters the
buffer, or the selection, through it. A `formatter` or `linter` that a syntax names runs from there too: `^T` `^O`
formats the buffer, `^T` `^Y` lints the file and steps through what the linter reported.

It reads `/etc/nanorc` and `~/.nanorc` when they exist; none is shipped, so there is no syntax highlighting until
you add `syntax` lines or `include` files of your own. Spell checking (`-s`) and the file browser are not built in.

`TERM` is `xterm-256color`.

## Examples

```
nano notes.txt
nano -l +20 script.sh
nano ~/.nanorc
```

## License

GNU nano 9.2, GPL-3.0-or-later, linked with ncurses 6.5 (X11 license). The license text is in `/usr/share/licenses/@ecmaos/coreutils-copyleft/nano/`. The source it was built from, and what ecmaOS changed, is described in `/usr/share/licenses/@ecmaos/coreutils-copyleft/nano/SOURCE`; the site that served the program also serves the source archive at `/sources/`.
