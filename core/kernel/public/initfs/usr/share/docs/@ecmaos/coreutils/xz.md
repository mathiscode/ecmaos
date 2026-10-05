# xz

`man @ecmaos/coreutils/xz`

## Synopsis

```
xz [-cdkfvz0-9e] [-T N] [FILE]...
unxz, xzcat, lzma, unlzma, lzcat
```

## Description

XZ Utils 5.8.4. `unxz`, `xzcat`, `lzma`, `unlzma` and `lzcat` are links to it. Compresses to `.xz` (or `.lzma`), removing the input unless `-k` is given. Single-threaded: `-T` is accepted and does nothing. The `xzdiff`/`xzgrep` family of scripts is not included.

## Examples

```
xz -9 backup.tar
xzcat backup.tar.xz | tar -tf -
xz -dk archive.xz
```

## License

0BSD. The license text is in `/usr/share/licenses/@ecmaos/coreutils/xz/`.
