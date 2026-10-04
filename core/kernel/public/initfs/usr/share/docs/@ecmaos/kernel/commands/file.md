# file

`man @ecmaos/kernel/commands/file`

## Synopsis

```
file [OPTION]... FILE...
```

## Description

Says what each FILE is, from its first bytes: archives (gzip, zip, tar, bzip2, xz), images (PNG, JPEG, GIF, WebP), PDF, WebAssembly, ELF, audio, SQLite, scripts (by their `#!` line), XML, HTML, JSON, text (ASCII or UTF-8, noting CRLF line ends) and otherwise `data`. Also directories, links and devices.

## Options

- `-b, --brief`: do not prefix the answer with the file name
- `-i, --mime`: print the MIME type (with charset for text)
- `--mime-type`: print only the MIME type

## Notes

It knows the common signatures, not the whole magic database.

## Exit status

0, or 1 when a file could not be opened.

## See also

`@ecmaos/kernel/commands/stat`, `@ecmaos/kernel/commands/xxd`
