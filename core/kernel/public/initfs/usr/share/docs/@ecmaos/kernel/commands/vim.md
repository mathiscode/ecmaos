# vim

`man @ecmaos/kernel/commands/vim`

## Synopsis

```
vim [-R] [-n] [-u VIMRC] [-c COMMAND] [FILE]...
```

## Description

Vim 9.1, the modal text editor, built to WebAssembly and run as an ordinary program on the terminal: it takes
the keyboard in raw mode and reads the window size from it, so it follows the terminal's size and gives the
terminal back when it exits. For a smaller, faster-starting editor see `vi`.

This is Vim's `normal` feature set: modes (insert, normal, visual, replace, command-line), motions,
operators and text objects, counts, `.` repeat, registers, marks, macros, undo and redo (also across
sessions with `:set undofile`), search with regular expressions, `:s`, `:g`, `:r`, `:set`, `:map`,
windows (`:split`, `:vsplit`) and tabs, buffers, folding, `:diffthis`, the quickfix list, completion, and
Vimscript.

Startup reads `/etc/vimrc` (which turns off vi compatibility, swap files and backup files) and then
`~/.vimrc`. Edit either to taste; `-u NONE` skips both, though that leaves vi compatibility on.

Not supported:

- Syntax highlighting, filetype detection and `:help`: they read Vim's runtime directory, which is not shipped.
- Shell escapes (`:!`, `:r !`, filters) and anything that starts a program: a browser cannot fork.
- `^C` ends the editor instead of interrupting a command, and a terminal resize is picked up on the next
  redraw (`^L`), because signals are not delivered to the program.
- Plugins, `+python`, `+lua` and other optional features.

## Examples

```
vim notes.txt
vim -R /etc/passwd
```
