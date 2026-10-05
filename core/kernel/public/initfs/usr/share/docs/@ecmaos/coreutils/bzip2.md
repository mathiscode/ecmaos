# bzip2

`man @ecmaos/coreutils/bzip2`

## Synopsis

```
bzip2 [-cdfkqtvz123456789] [FILE]...
bunzip2 [FILE]...
bzcat [FILE]...
```

## Description

bzip2 1.0.8, the block-sorting compressor. `bunzip2` and `bzcat` are links to it and act by the name they are run under. Without a file it filters standard input to standard output. `FILE` becomes `FILE.bz2` and is removed unless `-k` is given.

## Examples

```
bzip2 notes.txt
bzcat notes.txt.bz2 | head
tar -cf - src | bzip2 > src.tar.bz2
```

## License

bzip2-1.0.8 (BSD-style). The license text is in `/usr/share/licenses/@ecmaos/coreutils/bzip2/`.
