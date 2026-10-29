# cmp

`man @ecmaos/coreutils/cmp`

## Synopsis

```
cmp [OPTION]... FILE1 [FILE2 [SKIP1 [SKIP2]]]
```

## Description

Compare two files byte by byte. With no FILE, or when FILE is -, read standard input.

## Options

```
  -b, --print-bytes          print differing bytes
  -i, --ignore-initial=SKIP  skip first SKIP bytes of both inputs
  -i, --ignore-initial=SKIP1:SKIP2  skip first SKIP1 bytes of FILE1 and first SKIP2 bytes of FILE2
  -l, --verbose              output byte numbers and differing byte values
  -n, --bytes=LIMIT          compare at most LIMIT bytes
  -s, --quiet, --silent      suppress all normal output
  --help                     display this help and exit
```
