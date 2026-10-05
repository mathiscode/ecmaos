# mg

`man @ecmaos/coreutils/mg`

## Synopsis

```
mg [-nR] [-b FILE] [-f MODE] [-u FILE] [+NUMBER] [FILE]...
```

## Description

mg, a small Emacs-style editor from OpenBSD, on the terminal in raw mode. The usual Emacs keys work: `C-f C-b C-n C-p`, `C-a C-e`, `C-k` and `C-y`, `C-s` and `C-r` to search, `C-x C-f` to open, `C-x C-s` to save, `C-x b` to switch buffers, `C-x 2` to split, `C-g` to cancel, `C-x C-c` to quit. `M-x` runs a command by name. This build has no syntax highlighting and no pty-based batch mode (`-f`).

## Examples

```
mg notes.txt
mg +42 main.c
```

## License

Public domain, with ISC and BSD parts; statically linked with ncurses (X11 license). The license text is in `/usr/share/licenses/@ecmaos/coreutils/mg/`.
