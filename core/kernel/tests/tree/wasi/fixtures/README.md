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
