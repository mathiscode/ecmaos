# zstd

`man @ecmaos/kernel/commands/zstd`

## Synopsis

```
zstd [-cdkf#] [--rm] [-o FILE] [FILE]...
unzstd, zstdcat
```

## Description

Zstandard 1.5.7. `unzstd` and `zstdcat` are links to it. Unlike `gzip` and `xz`, zstd keeps its input unless `--rm` is given. Single-threaded: `-T` is accepted and ignored. Levels 1 to 19 (`--ultra` for 20 to 22), dictionaries and `.zst` files; the zlib, xz and lz4 file formats are not built in.

## Examples

```
zstd -19 big.log
zstdcat big.log.zst | grep error
zstd -d --rm big.log.zst
```

## License

BSD-3-Clause (zstd is dual-licensed BSD or GPLv2; this build uses it under BSD). The license text is in `/usr/share/licenses/@ecmaos/coreutils/zstd/`.
