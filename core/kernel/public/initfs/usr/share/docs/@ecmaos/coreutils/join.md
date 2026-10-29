# join

`man @ecmaos/coreutils/join`

## Synopsis

```
join [OPTION]... FILE1 FILE2
```

## Description

For each pair of input lines with identical join fields, write a line to standard output. The default join field is the first, delimited by blanks.

## Options

```
  -a FILENUM        also print unpairable lines from file FILENUM, where FILENUM is 1 or 2
  -e STRING         replace missing input fields with STRING
  -i, --ignore-case ignore differences in case when comparing fields
  -j FIELD          equivalent to '-1 FIELD -2 FIELD'
  -o FORMAT         obey FORMAT while constructing output line
  -t CHAR           use CHAR as input and output field separator
  -v FILENUM        like -a FILENUM, but suppress joined output lines
  -1 FIELD          join on this FIELD of file 1
  -2 FIELD          join on this FIELD of file 2
  -z, --zero-terminated  line delimiter is NUL, not newline
  --help            display this help and exit

FORMAT is one or more comma or blank separated specifications, each being 'FILENUM.FIELD' or '0' (the join field).
```
