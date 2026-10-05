# base64

`man @ecmaos/coreutils/base64`

## Synopsis

```
base64 [OPTION]... [FILE]
```

## Description

Encodes FILE, or standard input, as base64, wrapping the output at 76 columns; with `-d` it decodes.

## Options

- `-d, --decode`: decode data
- `-i, --ignore-garbage`: when decoding, ignore characters outside the alphabet
- `-w, --wrap=COLS`: wrap encoded lines after COLS characters; 0 never wraps

## Exit status

0, or 1 for invalid input or an unreadable file.

## See also

`@ecmaos/coreutils/xxd`, `@ecmaos/coreutils/md5sum`
