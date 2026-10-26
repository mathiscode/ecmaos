# python3

`man @ecmaos/coreutils/python3`

## Synopsis

```
python3 [-c COMMAND | -m MODULE | FILE] [ARGS]
python3
```

## Description

CPython 3.14.9, built to WebAssembly and run as an ordinary program in `/bin/python3` (`/bin/python` links to it). With no arguments it starts the REPL, with readline. `os.fork`, `subprocess`, `multiprocessing`, `asyncio`, threads and signals work.

The standard library is unpacked to `/usr/lib/python3.14`, compiled ahead of time. `zlib` (so `gzip`, `zipfile` and `tarfile`'s gz mode) is included; `bz2`, `lzma`, `ssl`, `ctypes` and `sqlite3` are not. The interpreter runs about half as fast as one without fork support.

## Examples

```
python3 -c 'print(sum(range(10)))'
python3 script.py
```

## See also

`@ecmaos/coreutils/dash`

## License

PSF-2.0. The license text is in `/usr/share/licenses/@ecmaos/coreutils/python3/`.
