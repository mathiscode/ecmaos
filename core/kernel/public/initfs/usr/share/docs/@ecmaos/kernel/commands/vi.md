# vi

`man @ecmaos/kernel/commands/vi`

## Synopsis

```
vi [-R] [-c COMMAND] [FILE]...
vim [-R] [-c COMMAND] [FILE]...
```

## Description

A modal text editor that runs in the terminal. It is busybox's `vi`, built to WebAssembly and run as an
ordinary program on the terminal: it takes the keyboard in raw mode and reads the window size from it,
so it follows the terminal's size and gives the terminal back when it exits. `vim` is another name for it.

Supported: insert, normal and `:` command modes, motions and operators, counts, `.` repeat, yank and
put with named registers, marks, undo, search with regular expressions (`/`, `?`, `n`, `N`), `:s`
substitution, `:w`, `:q`, `:wq`, `:q!`, `:r FILE` and `:set`.

Not supported: visual mode, redo, shell escapes (`:!`), Vimscript, plugins, syntax highlighting, split
windows and tabs.

## Options

```
  -R          open read-only
  -c COMMAND  run an ex command after the file is loaded
  FILE        file(s) to edit
```

## Examples

```
vi notes.txt          edit notes.txt
vi -R /etc/passwd     look at a file without changing it
```

## See also

`less`, `sed`
