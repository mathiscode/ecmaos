# WASI fixtures

`emcc-hello.wasm` is a real, ordinary (non-`STANDALONE_WASM`) `emcc` build of `emcc-hello.c`,
committed so the worker-side `env.__syscall_*` shim (`src/bin/wasi-preview1.mjs`) has something
real to run against without an `emcc` toolchain in every test environment. Rebuild it with:

```
emcc emcc-hello.c -o emcc-hello.wasm
```

Built and verified against emscripten 6.0.9. It writes to stdout, creates and stats a real file
under `/tmp` through `env.__syscall_openat`/`__syscall_fstat64`/`__syscall_stat64`, makes a
directory through `__syscall_mkdirat`, and exits with code 3.

`emcc-tty.wasm` is `emcc-tty.c` built with `-sSTANDALONE_WASM=0` (an output ending in `.wasm` makes
emscripten 6 default to standalone mode, which compiles `ioctl` and `poll` to stubs; the non-standalone
build imports `env.__syscall_ioctl`, `__syscall_poll` and `__syscall_poll_nonblocking` for real):

```
emcc emcc-tty.c -O1 -sSTANDALONE_WASM=0 -o emcc-tty.js && rm emcc-tty.js
```

It puts the terminal in raw mode, reads its size, polls for a key and restores the terminal.
