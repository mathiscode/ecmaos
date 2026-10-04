# hexdump

`man @ecmaos/kernel/commands/hexdump`

## Synopsis

```
hexdump [OPTION]... [FILE]...
```

## Description

Displays FILEs, or standard input, in hexadecimal. With `-C`, the canonical form: an offset, sixteen bytes in hex, and their printable characters between bars. Without it, the bytes as 16-bit words in little-endian order. A run of identical lines is shown as a single `*` unless `-v`.

## Options

- `-C, --canonical`: hex bytes beside their characters
- `-n, --length=N`: read only N bytes
- `-s, --skip=N`: skip N bytes first
- `-v, --no-squeezing`: show every line

## Exit status

0, or 1 when a file could not be read.

## See also

`@ecmaos/kernel/commands/xxd`, `@ecmaos/kernel/commands/od`
