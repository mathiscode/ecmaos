# uniq

`man @ecmaos/coreutils/uniq`

## Synopsis

```
uniq [OPTION]... [INPUT [OUTPUT]]
```

## Description

Filter adjacent matching lines from INPUT (or standard input), writing to OUTPUT (or standard output).

## Options

```
  -c, --count           prefix lines by the number of occurrences
  -d, --repeated        only print duplicate lines, one for each group
  -D                    print all duplicate lines
  -f, --skip-fields=N   avoid comparing the first N fields
  -i, --ignore-case     ignore differences in case when comparing
  -s, --skip-chars=N    avoid comparing the first N characters
  -u, --unique          only print unique lines
  -z, --zero-terminated line delimiter is NUL, not newline
  -w, --check-chars=N   compare no more than N characters in lines
  --help                display this help and exit

A field is a run of blanks (usually spaces and/or TABs), then non-blank characters. Fields are skipped before chars.
```
