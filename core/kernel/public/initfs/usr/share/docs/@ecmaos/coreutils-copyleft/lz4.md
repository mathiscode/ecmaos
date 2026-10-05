# lz4

`man @ecmaos/coreutils-copyleft/lz4`

## Synopsis

```
lz4 [-cdkf#] [--rm] [-o FILE] [FILE]...
unlz4, lz4cat
```

## Description

LZ4 1.10.0, the very fast compressor. `unlz4` and `lz4cat` are links to it. It writes `FILE.lz4` and keeps the input unless `--rm` is given. `-1` to `-12` set the level (`-9` and up use the slower high-compression mode), `-d` decompresses, `-c` writes to standard output, `-t` tests a file and `-b` runs the built-in benchmark. Single-threaded. With no file it filters standard input to standard output.

## Examples

```
lz4 -9 big.log
lz4cat big.log.lz4 | grep error
lz4 -d --rm big.log.lz4
```

## License

GPL-2.0-or-later for the command line tool; liblz4, linked into it, is BSD-2-Clause. The license texts and the source offer are in `/usr/share/licenses/@ecmaos/coreutils-copyleft/lz4/`.
