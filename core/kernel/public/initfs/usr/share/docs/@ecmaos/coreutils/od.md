# od

`man @ecmaos/coreutils/od`

## Synopsis

```
od [OPTION]... [FILE]...
```

## Description

Write an unambiguous representation, octal bytes by default, of FILE to standard output. With no FILE, or when FILE is -, read standard input.

Without `-t` the type is `o2` (two-byte octal words), as in GNU `od`. Floating types use `%.9g` and `%.17g`; `long double` is read as a double.

## Options

```
  -A, --address-radix=RADIX   output format for file offsets; RADIX is one of [doxn], for Decimal, Octal, Hex or None
  -j, --skip-bytes=BYTES      skip BYTES input bytes first
  -N, --read-bytes=BYTES      limit dump to BYTES input bytes
  -t, --format=TYPE           select output format or formats
  -v, --output-duplicates     do not use * to mark line suppression
  -w[BYTES], --width[=BYTES]  output BYTES bytes per output line; 32 is implied when BYTES is not specified

Output format shorthands: -a (-t a), -b (-t o1), -c (-t c), -d (-t u2), -f (-t fF), -i (-t dI), -l (-t dL), -o (-t o2), -s (-t d2), -x (-t x2).

TYPE is made up of one or more of these specifications: a (named character, ignoring high-order bit), c (printable character or backslash escape), d[SIZE] (signed decimal), f[SIZE] (floating point), o[SIZE] (octal), u[SIZE] (unsigned decimal), x[SIZE] (hexadecimal). SIZE is a number; for d, o, u and x it may be C, S, I or L (char, short, int, long), for f it may be F, D or L (float, double, long double).
```
