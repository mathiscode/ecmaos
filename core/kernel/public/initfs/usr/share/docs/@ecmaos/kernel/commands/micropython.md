# micropython (python)

`man @ecmaos/kernel/commands/micropython`

## Synopsis

```
micropython [-X heapsize=SIZE] [-i] [-c COMMAND | -m MODULE | FILE [ARGS...]]
```

## Description

MicroPython 1.29, a lean implementation of Python 3 (the Unix port). With no arguments it is an interactive REPL with history and tab completion, and it reads a script from a pipe when its input is not a terminal. `sys.argv` holds the arguments. `-i` enters the REPL after the script, and `-X heapsize=SIZE` sets the heap (`64k`, `32m`; the default is 16 MiB).

`python` is a link to `micropython`, so scripts that start with `#!/usr/bin/env python` run, as long as they stay within what MicroPython has.

This is MicroPython, not CPython. It has the core language, `asyncio`, and the usual small standard library: built in, `sys`, `time`, `re`, `json`, `struct`, `hashlib`, `io`, `errno`, `array`, `binascii`, `select` and `gc`; frozen in from micropython-lib, `os` with `os.path`, `argparse`, `datetime`, `shutil`, `contextlib`, `copy`, `unittest`, `pathlib`, `tempfile`, `logging`, `collections`, `functools`, `itertools`, `operator`, `bisect`, `heapq`, `fnmatch`, `stat`, `string`, `random`, `traceback`, `types` and `warnings`. These are smaller than CPython's: `os.path` has `join`, `split`, `basename`, `dirname`, `exists`, `isfile`, `isdir` and a few more; there is no `os.walk`, and `shutil` has `rmtree`, `copyfileobj` and `disk_usage`. There is no `textwrap`, `socket`, `threading` or `subprocess`, and `re` has no lookahead or lookbehind. `os.system` runs a command through `/bin/ecmash`. A traceback goes to standard error and the exit status is 1; `sys.exit(n)` exits with `n`; a missing script exits 2. Running out of heap raises `MemoryError`.

## Examples

```
micropython -c 'print(sum(range(10)))'
micropython script.py arg1 arg2
echo 'print(6 * 7)' | micropython
micropython -X heapsize=64m big.py
micropython   # REPL
```

## License

MIT; the modules frozen in from micropython-lib that come from CPython are under the Python License. Both texts are in `/usr/share/licenses/@ecmaos/coreutils/micropython/`.
