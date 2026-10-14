# sort

`man @ecmaos/coreutils/sort`

## Synopsis

```
sort [OPTION]... [FILE]...
```

## Description

Write sorted concatenation of all FILE(s) to standard output. With no FILE, or when FILE is -, read standard input.

Lines are compared as bytes, as in GNU `sort` in the C locale: uppercase sorts before lowercase. When two lines are equal on the keys, the whole line decides, unless `-s` or `-u` is given. Numbers (`-n`, `-g`, `-h`) are compared as doubles. A missing file exits 2.

## Options

```
  -b, --ignore-leading-blanks   ignore leading blanks
  -d, --dictionary-order        consider only blanks and alphanumeric characters
  -f, --ignore-case             fold lower case to upper case characters
  -g, --general-numeric-sort    compare according to general numerical value
  -i, --ignore-nonprinting      consider only printable characters
  -M, --month-sort              compare (unknown) < 'JAN' < ... < 'DEC'
  -h, --human-numeric-sort      compare human readable numbers (e.g., 2K 1G)
  -n, --numeric-sort            compare according to string numerical value
  -r, --reverse                 reverse the result of comparisons
  -V, --version-sort            natural sort of (version) numbers within text

  -c, --check, -C               check whether input is sorted; do not sort
  -k, --key=KEYDEF              sort via a key; KEYDEF gives location and type
  -o, --output=FILE             write result to FILE instead of standard output
  -s, --stable                  stabilize sort by disabling last-resort comparison
  -t, --field-separator=SEP     use SEP instead of non-blank to blank transition
  -u, --unique                  with -c, check for strict ordering; without -c, output only the first of an equal run
  -z, --zero-terminated         line delimiter is NUL, not newline
  --help                        display this help and exit

KEYDEF is F[.C][OPTS][,F[.C][OPTS]] for start and stop position, where F is a field number and C a character position in the
field; both are origin 1. OPTS is one or more of [bdfgiMhnRrV], which override global ordering options for that key.
```

## See also

`sort --help`
