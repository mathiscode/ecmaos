# rg

`man @ecmaos/coreutils/rg`

## Synopsis

```
rg [OPTIONS] PATTERN [PATH]...
rg [OPTIONS] --files [PATH]...
```

## Description

ripgrep 15.2.0: it searches files for a regular expression, recursively from the working directory (or the PATHs), and skips what `.gitignore`, `.ignore` and `.rgignore` files exclude, as well as hidden and binary files. It searches several files at once on threads.

This is the real ripgrep, built in Rust for WALI. `rg --help` lists every option, and the full guide is at https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md.

With no PATH and something other than a terminal on standard input, rg searches standard input, as it does on Linux. A script that means the working directory can give `.` or `< /dev/null`.

Files are read rather than memory-mapped. `--pre`, which runs a preprocessor on each file, works through child processes as it does elsewhere.

## Common options

```
  -i, --ignore-case      -S, --smart-case      -w, --word-regexp      -F, --fixed-strings
  -n, --line-number      -c, --count           -l, --files-with-matches
  -g, --glob GLOB        -t, --type TYPE       -T, --type-not TYPE    --type-list
  -A/-B/-C NUM           context lines
  -u, -uu, -uuu          search ignored, hidden and binary files too
  --files                list the files that would be searched
  -j, --threads NUM      -o, --only-matching   -r, --replace TEXT     --json
```

## See also

`grep`, `fd`
