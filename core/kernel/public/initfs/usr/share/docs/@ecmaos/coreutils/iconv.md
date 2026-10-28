# iconv

`man @ecmaos/coreutils/iconv`

## Synopsis

```
iconv [-f FROM] [-t TO[//TRANSLIT|//IGNORE]] [-c] [-o FILE] [FILE]...
iconv -l
```

## Description

Convert text from one character encoding to another. Both encodings default to UTF-8.

Decoding is the browser's, so every encoding of the WHATWG Encoding Standard can be read. Encoding is done here, and covers:

- UTF-8, and UTF-16 and UTF-32 in either byte order (plain `UTF-16` and `UTF-32` write a byte order mark)
- ASCII and true ISO-8859-1
- every single-byte charset: the other ISO-8859 parts, the Windows code pages (CP1250 to CP1258, CP874), KOI8-R/U, Mac Roman and IBM866

Text cannot be written in the multi-byte East Asian charsets (Shift_JIS, EUC-JP, GBK, GB18030, Big5, EUC-KR), though it can be read from them.

`//TRANSLIT` spells out what the target lacks where it can: `EUR` for €, `--` for —, quotes as `'` and `"`. Otherwise it writes the base letter or `?`. `//IGNORE` and `-c` leave such characters out. When a character cannot be read or written, the text converted so far is written and the position of the problem is reported, with status 1.

## Options

```
  -f, --from-code=NAME  the input encoding
  -t, --to-code=NAME    the output encoding
  -c                    omit what cannot be converted
  -l, --list            the encodings known
  -o, --output=FILE     write to FILE
```

## See also

`file`
