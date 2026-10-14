# nl

`man @ecmaos/coreutils/nl`

## Synopsis

```
nl [OPTION]... [FILE]...
```

## Description

Write each FILE to standard output, with line numbers added. With no FILE, or when FILE is -, read standard input.

## Options

```
  -b, --body-numbering=STYLE      use STYLE for numbering body lines
  -d, --section-delimiter=CC      use CC for logical page delimiters
  -f, --footer-numbering=STYLE    use STYLE for numbering footer lines
  -h, --header-numbering=STYLE    use STYLE for numbering header lines
  -i, --line-increment=NUMBER     line number increment at each line
  -l, --join-blank-lines=NUMBER   group of NUMBER empty lines counted as one
  -n, --number-format=FORMAT      insert line numbers according to FORMAT (ln, rn, rz)
  -p, --no-renumber               do not reset line numbers for each section
  -s, --number-separator=STRING   add STRING after (possible) line number
  -v, --starting-line-number=NUM  first line number for each section
  -w, --number-width=NUMBER       use NUMBER columns for line numbers
  --help                          display this help and exit

STYLE is one of: a (number all lines), t (number only nonempty lines), n (number no lines), pBRE (number only lines that
match the regular expression BRE).
```

## See also

`nl --help`
