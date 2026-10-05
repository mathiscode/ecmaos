# vim

`man @ecmaos/kernel/commands/vim`

## Synopsis

```
vim [-R] [-n] [-u VIMRC] [-c COMMAND] [FILE]...
vi  [-R] [-n] [-u VIMRC] [-c COMMAND] [FILE]...
```

## Description

Vim 9.1, the modal text editor, built to WebAssembly and run as an ordinary program on the terminal: it takes
the keyboard in raw mode and reads the window size from it, so it follows the terminal's size and gives the
terminal back when it exits. `vi` is another name for it.

This is Vim's `normal` feature set: modes (insert, normal, visual, replace, command-line), motions,
operators and text objects, counts, `.` repeat, registers, marks, macros, undo and redo (also across
sessions with `:set undofile`), search with regular expressions, `:s`, `:g`, `:r`, `:set`, `:map`,
windows (`:split`, `:vsplit`) and tabs, buffers, folding, `:diffthis`, the quickfix list, completion, and
Vimscript.

Startup reads `/etc/vimrc` (which turns off vi compatibility, swap files and backup files) and then
`~/.vimrc`. Edit either to taste; `-u NONE` skips both, though that leaves vi compatibility on.

Syntax highlighting, filetype detection, indentation and a few colour schemes work, from a subset of Vim's runtime
in `/usr/share/vim/vim91` (C and C++, shell, JavaScript and TypeScript, JSON, Python, HTML, CSS, Markdown, Make,
YAML, TOML, Dockerfile, SQL, Lua, Rust, Go, Java and config files, among others). Other languages open without
highlighting.

Shell commands work: `:!cmd`, `:r !cmd`, filters such as `:%!sort`, and `system()` run the command with
`/bin/ecmash -c` (the `shell` option is set to `/bin/sh`, which is `ecmash`). The command shares Vim's terminal
and `^C` stops it, not Vim. A terminal resize reaches Vim as `SIGWINCH`, so it redraws at once.

Not supported:

- `:help`: the help files are not shipped.
- `:shell` and `:terminal` (an interactive child on a pseudo-terminal), and `+job` and `+channel`.
- Plugins, `+python`, `+lua` and other optional features.

## Examples

```
vim notes.txt
vim -R /etc/passwd
```

## License

Vim 9.1.0, under the Vim license; this is a modified version (`:version` says so). The license text is in `/usr/share/licenses/@ecmaos/coreutils-copyleft/vim/`. The source it was built from, and what ecmaOS changed, is described in `/usr/share/licenses/@ecmaos/coreutils-copyleft/vim/SOURCE`; the site that served the program also serves the source archive at `/sources/`.
