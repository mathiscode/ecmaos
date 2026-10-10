# grep

`man @ecmaos/coreutils/grep`

## Synopsis

```
grep [OPTION]... PATTERN [FILE]...
```

## Description

Search for PATTERN in each FILE.

## Options

```
  -i, --ignore-case   ignore case distinctions
  -v                  select non-matching lines
  -q                  print nothing; exit 0 if a line matched
  -F                  PATTERN is a fixed string
  -E                  PATTERN is an extended regular expression (the default)
  -n, --line-number   print line number with output lines
  -c, --count         print only a count of matching lines per FILE
  --color[=WHEN]      mark matches, file names and line numbers in color: always, auto (the default for --color) or never
  --help              display this help and exit
```

## See also

`grep --help`

`--color` marks each match in bold red, file names in magenta, line numbers in green and the separators in cyan (GNU grep's defaults; `$GREP_COLORS` changes `ms`, `fn`, `ln` and `se`). `auto` colors only when standard output is a terminal, so a pipe stays plain; `-v` has no matches to mark. The default `.bashrc` in `/etc/skel` aliases `grep`, `egrep` and `fgrep` to `--color=auto`.
