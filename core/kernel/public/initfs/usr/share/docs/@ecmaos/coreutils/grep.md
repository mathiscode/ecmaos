# grep

`man @ecmaos/coreutils/grep`

## Synopsis

```
grep [OPTION]... PATTERNS [FILE]...
```

## Description

Search for PATTERNS in each FILE. PATTERNS can contain multiple patterns separated by newlines.

Patterns are POSIX basic regular expressions by default, as in GNU `grep`; `-E` makes them extended, `-F` fixed strings and `-P` JavaScript regular expressions. The exit status is 0 if a line was selected, 1 if none was, and 2 on an error (unless `-q` found a match). With `-r` and no file, the current directory is searched and names have no `./` prefix; directories are read in sorted order.

## Options

```
Pattern selection and interpretation:
  -E, --extended-regexp     PATTERNS are extended regular expressions
  -F, --fixed-strings       PATTERNS are strings
  -G, --basic-regexp        PATTERNS are basic regular expressions
  -P, --perl-regexp         PATTERNS are JavaScript regular expressions
  -e, --regexp=PATTERNS     use PATTERNS for matching
  -f, --file=FILE           take PATTERNS from FILE
  -i, --ignore-case         ignore case distinctions in patterns and data
  -w, --word-regexp         match only whole words
  -x, --line-regexp         match only whole lines
Miscellaneous:
  -s, --no-messages         suppress error messages
  -v, --invert-match        select non-matching lines
Output control:
  -m, --max-count=NUM       stop after NUM selected lines
  -b, --byte-offset         print the byte offset with output lines
  -n, --line-number         print line number with output lines
  -H, --with-filename       print file name with output lines
  -h, --no-filename         suppress the file name prefix on output
  -o, --only-matching       show only nonempty parts of lines that match
  -q, --quiet, --silent     suppress all normal output
  -L, --files-without-match print only names of FILEs with no selected lines
  -l, --files-with-matches  print only names of FILEs with selected lines
  -c, --count               print only a count of selected lines per FILE
      --color[=WHEN]        use markers to highlight the matching strings; WHEN is 'always', 'never', or 'auto'
  -a, --text                process a binary file as if it were text
  -z, --null-data           a data line ends in 0 byte, not newline
Context control:
  -B, --before-context=NUM  print NUM lines of leading context
  -A, --after-context=NUM   print NUM lines of trailing context
  -C, --context=NUM         print NUM lines of output context
  -NUM                      same as --context=NUM
File and directory selection:
  -r, --recursive           like --directories=recurse
  -R, --dereference-recursive  likewise, but follow all symlinks
      --include=GLOB        search only files that match GLOB
      --exclude=GLOB        skip files that match GLOB
      --exclude-dir=GLOB    skip directories that match GLOB
  --help                    display this help and exit
```

## Colors

`--color` marks each match in bold red, file names in magenta, line numbers in green and the separators in cyan (GNU grep's defaults; `$GREP_COLORS` changes `ms`, `fn`, `ln` and `se`). `auto` colors only when standard output is a terminal, so a pipe stays plain; `-v` has no matches to mark. The default `.bashrc` in `/etc/skel` aliases `grep`, `egrep` and `fgrep` to `--color=auto`.
