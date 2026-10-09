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

`emcc-errno.wasm` is `emcc-errno.c` built the same way as `emcc-tty.wasm`. It checks that a failed call
leaves `errno` equal to the `ENOENT`/`EISDIR` it was compiled with: emscripten 6 numbers errors like WASI
(ENOENT is 44), not like Linux (2). Rebuild it with:

```sh
emcc emcc-errno.c -O1 -sSTANDALONE_WASM=0 -o emcc-errno.js && rm emcc-errno.js
```

`emcc-readdir.wasm` is `emcc-readdir.c` built the same way. It creates 300 files and reads the directory
twice (with `rewinddir` between), which takes several `getdents64` calls each; the shim must keep a read
position per directory descriptor or the loop never ends. Rebuild it with:

```sh
emcc emcc-readdir.c -O1 -sSTANDALONE_WASM=0 -o emcc-readdir.js && rm emcc-readdir.js
```

`emcc-inet6.wasm` is `emcc-inet6.c` (IPv6 on loopback: `getaddrinfo`/`getnameinfo`, `sockaddr_in6`, v6-only and dual-stack TCP, IPv6 UDP, family errors, no route), built the same way:

```sh
emcc emcc-inet6.c -O1 -sSTANDALONE_WASM=0 -o emcc-inet6.js && rm emcc-inet6.js
```

`emcc-scm.wasm` (`emcc-scm.c`: `SCM_RIGHTS`, `SCM_CREDENTIALS`, `SO_PEERCRED` in one program) and `emcc-scm-peer.wasm` (`emcc-scm-peer.c`: a descriptor sent from one program to another) are built the same way:

```sh
emcc emcc-scm.c -O1 -sSTANDALONE_WASM=0 -o emcc-scm.js && rm emcc-scm.js
emcc emcc-scm-peer.c -O1 -sSTANDALONE_WASM=0 -o emcc-scm-peer.js && rm emcc-scm-peer.js
```
