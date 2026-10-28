# rsync

`man @ecmaos/coreutils-copyleft/rsync`

## Synopsis

```
rsync [OPTION]... SRC... DEST
rsync [OPTION]... SRC... [USER@]HOST:DEST
rsync [OPTION]... [USER@]HOST:SRC... DEST
```

## Description

rsync 3.5.1, built for WebAssembly on WALI's musl: the real program, not a reimplementation. It copies trees locally, sending only what changed. It also talks to any other rsync over a remote shell. For `HOST:PATH` it runs `ssh HOST rsync --server` (the `ssh` is dropbear's), so it reaches a Linux machine that has rsync installed, as it would from one. `-e` names another remote shell.

The common use is `rsync -av SRC/ DEST/`. `-a` keeps times, modes, links, and owners where that is permitted. Add `--delete` to remove what the source no longer has, `-z` to compress on the wire, `-n` to see what would happen, and `-P` to keep partial files and show progress.

It is built without the libraries this system lacks, so some features are missing:

- OpenSSL, xxhash, zstd and LZ4: checksums are MD5 and MD4, and compression is zlib, which every rsync speaks
- ACLs and extended attributes: `-A` and `-X` are refused
- iconv: no `--iconv`
- IDN

Running it as a daemon (`rsync --daemon`) has not been tried here; use it over ssh. rsync forks, so the binary is linked with Asyncify and is larger than its native build.

`rsync --help` lists every option, and the full manual is at https://download.samba.org/pub/rsync/rsync.1.

## See also

`scp`, `ssh`, `cp`, `tar`
