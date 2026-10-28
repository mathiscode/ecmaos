# fd

`man @ecmaos/coreutils/fd`

## Synopsis

```
fd [OPTIONS] [PATTERN] [PATH]...
```

## Description

fd 10.5.0: a friendlier `find`. It finds entries whose names match a regular expression (or a glob, with `-g`), under the working directory or the PATHs. Like ripgrep, it skips hidden files and what `.gitignore` excludes. It walks the tree on threads, and its colours follow `LS_COLORS`.

This is the real fd, built in Rust for WALI. `fd --help` lists every option, and the full documentation is at https://github.com/sharkdp/fd.

`-x COMMAND` runs a command for each result and `-X COMMAND` runs one command for all of them. Both take the rest of the command line as the command, so the pattern and paths come before them.

## Common options

```
  -H, --hidden        -I, --no-ignore     -s, --case-sensitive   -i, --ignore-case
  -g, --glob          -F, --fixed-strings -p, --full-path        -a, --absolute-path
  -t, --type f|d|l|x|e|s|p   -e, --extension EXT   -E, --exclude GLOB
  -d, --max-depth N   --min-depth N       -S, --size [+-]SIZE    --changed-within DATE
  -x, --exec CMD      -X, --exec-batch CMD   -0, --print0   -j, --threads N
```

## See also

`find`, `rg`
