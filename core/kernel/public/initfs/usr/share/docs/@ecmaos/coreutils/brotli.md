# brotli

`man @ecmaos/coreutils/brotli`

## Synopsis

```
brotli [-cdfkjt] [-q LEVEL] [-w BITS] [-o FILE] [FILE]...
```

## Description

Brotli 1.2.0, Google's compressor. It writes `FILE.br` next to the input and, like `zstd`, keeps the input unless `-j` is given. `-d` decompresses, `-c` writes to standard output, `-t` tests a file, `-q 0` to `-q 11` sets the level (11 is the default and the slowest), and `-w` sets the window size. With no file it filters standard input to standard output. There is no `unbrotli` link: use `brotli -d`.

## Examples

```
brotli -q 9 site.css
brotli -dc site.css.br | head
tar cf - src | brotli -c > src.tar.br
```

## License

MIT. The license text is in `/usr/share/licenses/@ecmaos/coreutils/brotli/`.
