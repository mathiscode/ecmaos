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

`emcc-mmap.wasm` (`emcc-mmap.c`: `mmap`, `msync` and `munmap` on an unlinked temp file and on the framebuffer named by `$FB`, with `FBIOGET_*` ioctls) is built like the others. It needs the kernel's `linux/fb.h`, which emscripten does not ship; the host's is used for the build only:

```sh
emcc emcc-mmap.c -O1 -sSTANDALONE_WASM=0 -idirafter /usr/include -o emcc-mmap.js && rm emcc-mmap.js
```

Emscripten has no `memfd_create` (the link fails), so the program uses `mkstemp` and `unlink`, which is also what Wayland's shared-memory helpers fall back to.

`wl-shm.wasm` and `wl-lib.wasm` are two Wayland test clients for `wlcomp` (`../../wayland.test.ts`): `wl-shm.c` speaks the wire protocol by hand, `wl-lib.c` is written against libwayland-client. `wl-lib.build.sh` rebuilds the second (it builds libwayland-client first, through `core/utils/wasm/lib/wayland.sh`, and needs the host `wayland-scanner`).

`sdl-win.wasm` is a small SDL 3 program (`sdl-win.c`) on SDL's Wayland video driver, run against `wlcomp` by the same test: a window surface, pointer, key and text events, resize, close. `sdl-win.build.sh` rebuilds it, and SDL itself first (`core/utils/wasm/lib/sdl.sh`, a few minutes; it needs `cmake`, `ninja`, `pkg-config`, `bison` and the host `wayland-scanner`). The same script is how any SDL 3 program gets built for ecmaOS.

`p2-echo.wasm` is a WASI Preview 2 component: `p2-echo.wat`, assembled and wrapped in the
`wasi_snapshot_preview1` command adapter by the jco the kernel already depends on, so no other toolchain is needed.
It writes its arguments one per line, copies stdin to stdout, says `p2-echo: done` on stderr and exits with the
number of arguments. Rebuild it from `core/kernel` with:

```sh
node tests/tree/wasi/fixtures/p2-echo.build.mjs
```

`wali-*.wasm` are built on WALI's musl, the C library ecmaOS is moving its programs to: `wali-libc.c` (arguments,
environment, Linux errno numbers, `*at` calls against a directory descriptor, readdir and rewinddir, a private file
mapping, descriptor flags and allocation), `wali-setjmp.c` (setjmp and longjmp on wasm exceptions), `wali-cxx.cpp`
(C++ exceptions, the standard library and `std::filesystem`), `wali-uncaught.cpp` (an exception nothing catches),
`wali-net.c` (socketpair, AF_UNIX and loopback TCP between processes, poll,
epoll, non-blocking calls, SIGPIPE, and a socket as a child's stdout) `wali-shared.c` (a shared file mapping in
step with the file across processes, and unmapped in part), `wali-tty.c` (a pty, stopping and continuing, and
reading the terminal from the background) and `wali-thread.c` (mutexes, condition variables, thread-local storage,
malloc from many threads at once, detached threads, and exit() from a thread); the last four start copies of themselves in the roles
named by their first argument. `wali-mmap.wasm` is `emcc-mmap.c` built on WALI, and `emcc-mmap.test.ts` runs both
builds with the same assertions; so are `wali-errno.wasm` and `wali-readdir.wasm` (`emcc-errno.test.ts`),
`wali-rawtty.wasm` from `emcc-tty.c` (`emcc-tty.test.ts`), `wali-inet6.wasm` (`emcc-inet6.test.ts`),
`wali-udp-msg.wasm` (`emcc-udp-msg.test.ts`), and `wali-proc.wasm` and `emcc-proc.c`, below.
`../wali.test.ts` runs them. `wali.build.sh` rebuilds them all with the pinned toolchain; the first run builds the
sysroot (`utils/check-wali.sh`, a minute or two):

```sh
tests/tree/wasi/fixtures/wali.build.sh
```

`emcc-proc.wasm` is `emcc-proc.c` (posix_spawn with file actions, pipes and close-on-exec, waitpid, execve, system and
popen, and signal handlers, masks, inheritance, alarm, sleep and pause; it starts copies of itself in the roles named by
its first argument) built with emcc and libecmaos (`core/utils/wasm/lib/ecmaos.sh`), which gives an Emscripten program
processes and the kernel's signals. `wali.build.sh` builds the same source on WALI as `wali-proc.wasm`, and
`../emcc-proc.test.ts` runs both with the same assertions. From this directory:

```sh
bash -c 'source ../../../../../utils/wasm/lib/ecmaos.sh && build_ecmaos "$(mktemp -d)" &&
  emcc emcc-proc.c -O1 -sSTANDALONE_WASM=0 $ECMAOS_LDFLAGS $ECMAOS_LIB -o emcc-proc.js' && rm emcc-proc.js
```

musl's libc-test, its functional and regression tests built on WALI's musl into one program, is in `../libc-test/`
(`build.sh` rebuilds it from a pinned commit; `expected-failures.txt` lists what fails today and why), and
`../libc-test.test.ts` runs it.
