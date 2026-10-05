# micropython

`man @ecmaos/kernel/commands/micropython`

## Synopsis

```
micropython [-X heapsize=SIZE] [-i] [-c COMMAND | -m MODULE | FILE [ARGS...]]
```

## Description

MicroPython 1.29, a lean implementation of Python 3 (the Unix port). With no arguments it is an interactive REPL with history and tab completion, and it reads a script from a pipe when its input is not a terminal. `sys.argv` holds the arguments. `-i` enters the REPL after the script, and `-X heapsize=SIZE` sets the heap (`64k`, `32m`; the default is 16 MiB).

This is MicroPython, not CPython. It has the core language and the usual small standard library (`os`, `sys`, `time`, `re`, `json`, `struct`, `hashlib`, `random`, `collections`, `io`, `errno`, `heapq`, `array`, `binascii`, `select`, `gc`), but no `os.path`, `argparse`, `datetime` or `pathlib`, no threads, and no `socket`. `os.system` runs a command through `/bin/ecmash`. A traceback goes to standard error and the exit status is 1; `sys.exit(n)` exits with `n`; a missing script exits 2. Running out of heap raises `MemoryError`.

## Examples

```
micropython -c 'print(sum(range(10)))'
micropython script.py arg1 arg2
echo 'print(6 * 7)' | micropython
micropython -X heapsize=64m big.py
micropython   # REPL
```

## License

MIT. The license text is in `/usr/share/licenses/@ecmaos/coreutils/micropython/`.
