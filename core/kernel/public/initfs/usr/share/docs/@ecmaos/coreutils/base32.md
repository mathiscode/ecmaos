# base32

`man @ecmaos/coreutils/base32`

## Synopsis

```
base32 [-d] [-i] [-w COLS] [FILE]
```

## Description

Encode FILE (or standard input) as base32 (RFC 4648), or decode it with `-d`. Encoded output is wrapped at 76 columns unless `-w` says otherwise; `-w 0` does not wrap.

## Options

```
  -d, --decode          decode
  -i, --ignore-garbage  when decoding, skip characters outside the alphabet
  -w, --wrap=COLS       wrap encoded lines after COLS characters
```

## See also

`base64`
