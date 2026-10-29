# paste

`man @ecmaos/coreutils/paste`

## Synopsis

```
paste [OPTION]... [FILE]...
```

## Description

Write lines consisting of the sequentially corresponding lines from each FILE, separated by TABs, to standard output. With no FILE, or when FILE is -, read standard input.

## Options

```
  -d, --delimiters=LIST   reuse characters from LIST instead of TABs
  -s, --serial            paste one file at a time instead of in parallel
  -z, --zero-terminated   line delimiter is NUL, not newline
  --help                  display this help and exit
```
