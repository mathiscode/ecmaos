# expand

`man @ecmaos/coreutils/expand`

## Synopsis

```
expand [OPTION]... [FILE]...
```

## Description

Convert tabs in each FILE to spaces, writing to standard output. With no FILE, or when FILE is -, read standard input.

## Options

```
  -i, --initial    do not convert tabs after non blanks
  -t, --tabs=N     have tabs N characters apart, not 8
  -t, --tabs=LIST  use comma separated list of tab positions; the last specified position can be prefixed with '/' to specify a tab size to use after the last explicitly specified tab stop
  --help           display this help and exit
```

## See also

`expand --help`
