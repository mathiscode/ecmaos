# gzip

`man @ecmaos/kernel/commands/gzip`

## Synopsis

```
gzip [OPTION]... [FILE]...
```

## Description

Compresses each FILE to FILE.gz and removes the original; with no FILE it compresses standard input to standard output. `-d` decompresses, as `gunzip` does.

## Options

- `-c, --stdout`: write to standard output and keep the original
- `-d, --decompress`: decompress
- `-k, --keep`: keep the original
- `-f, --force`: overwrite an existing output file
- `-t, --test`: check the integrity of compressed files
- `-v, --verbose`: say what is done
- `-1 .. -9`: accepted; the compression level is not adjustable here

## Notes

Compression uses the platform's gzip stream, which has no levels and does not record the file name or time in the header. What it writes is ordinary gzip that any `gunzip` reads.

## Exit status

0, 1 for an error, 2 for a warning (an unknown suffix, an existing output file).

## See also

`@ecmaos/kernel/commands/gunzip`, `@ecmaos/kernel/commands/zcat`, `@ecmaos/kernel/commands/tar`
