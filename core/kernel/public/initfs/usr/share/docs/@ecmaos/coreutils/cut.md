# cut

`man @ecmaos/coreutils/cut`

## Synopsis

```
cut OPTION... [FILE]...
```

## Description

Print selected parts of lines from each FILE to standard output. With no FILE, or when FILE is -, read standard input.

## Options

```
  -b, --bytes=LIST        select only these bytes
  -c, --characters=LIST   select only these characters
  -d, --delimiter=DELIM   use DELIM instead of TAB for field delimiter
  -f, --fields=LIST       select only these fields; also print any line that contains no delimiter character, unless -s
  -n                      (ignored)
      --complement        complement the set of selected bytes, characters or fields
  -s, --only-delimited    do not print lines not containing delimiters
      --output-delimiter=STRING  use STRING as the output delimiter; the default is to use the input delimiter
  -z, --zero-terminated   line delimiter is NUL, not newline
  --help                  display this help and exit

Use one, and only one of -b, -c or -f. Each LIST is made up of one range, or many ranges separated by commas.
Each range is one of: N, N-M, N- (from N to the end of the line), -M (from the first to M).
```

## See also

`cut --help`
