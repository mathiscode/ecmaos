# csplit

`man @ecmaos/coreutils/csplit`

## Synopsis

```
csplit [OPTION]... FILE PATTERN...
```

## Description

Split FILE into pieces named `xx00`, `xx01` and so on, at each pattern in turn, and print the size of each piece as it is written. A FILE of `-` is standard input. A pattern is one of these:

- `N`: a line number; the piece ends before line N
- `/RE/[OFFSET]`: the piece ends before the next line matching the basic regular expression RE, moved by OFFSET lines
- `%RE%[OFFSET]`: as above, but what comes before the line is skipped rather than written
- `{N}` repeats the pattern before it N more times, and `{*}` repeats it as long as it matches

When a pattern cannot be met, what is left is written as a piece and an error is reported. The pieces are then removed, unless `-k` is given.

## Options

```
  -b, --suffix-format=FORMAT  printf format for the number (%02d)
  -f, --prefix=PREFIX         instead of xx
  -k, --keep-files            keep the pieces after an error
      --suppress-matched      leave out the lines that matched
  -n, --digits=N              digits in the number (2)
  -s, --quiet                 do not print the sizes
  -z, --elide-empty-files     do not write empty pieces
```

## See also

`split`
