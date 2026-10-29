# seq

`man @ecmaos/coreutils/seq`

## Synopsis

```
seq [OPTION]... LAST
seq [OPTION]... FIRST LAST
seq [OPTION]... FIRST INCREMENT LAST
```

## Description

Print numbers from FIRST to LAST, in steps of INCREMENT.

Numbers have as many decimals as `FIRST` and `INCREMENT`; `-f` takes a printf floating-point format; `-w` pads with zeros.

## Options

```
  -f, --format=FORMAT      use printf style floating-point FORMAT
  -s, --separator=STRING   use STRING to separate numbers (default: \n)
  -w, --equal-width        equalize width by padding with leading zeroes
  --help                   display this help and exit

If FIRST or INCREMENT is omitted, it defaults to 1. That is, an omitted INCREMENT defaults to 1 even when LAST is smaller than FIRST.
```
