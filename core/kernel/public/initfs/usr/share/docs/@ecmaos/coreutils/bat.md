# bat

`man @ecmaos/coreutils/bat`

## Synopsis

```
bat [OPTIONS] [FILE]...
```

## Description

bat 0.26.1: `cat` with syntax highlighting for hundreds of languages, line numbers, a header, and paging through `less` when the output is a terminal. Piped or redirected, it writes the plain text, as `cat` would, unless `--color=always` or `--decorations=always` asks for more.

This is the real bat, built in Rust for WALI. It is built without git support, so there are no change markers in the margin. `bat --help` lists every option, and the full documentation is at https://github.com/sharkdp/bat.

## Common options

```
  -p, --plain          no decorations (twice: no paging either)
  -n, --number         line numbers only
  -l, --language LANG  --list-languages   --list-themes   --theme THEME
  -A, --show-all       show non-printable characters
  -r, --line-range N:M  -H, --highlight-line N
  --style numbers,header,grid,...   --color auto|always|never
  --decorations auto|always|never   --paging auto|always|never   --pager CMD
```

## See also

`cat`, `less`
