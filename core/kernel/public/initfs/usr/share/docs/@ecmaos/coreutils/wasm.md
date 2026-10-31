# wasm

`man @ecmaos/coreutils/wasm`

## Synopsis

```
./PROGRAM.wasm [ARG]...
```

## Description

Not a command: how ecmaOS runs a WebAssembly file. Any file that starts with the WebAssembly magic bytes is run by `execve`, in a worker of its own, as a process with a pid, signals, a controlling terminal and an exit status. Pipes, redirections, job control (`^C`, `^Z`, `bg`, `fg`) and `ps`, `kill` and `strace` work on it as on any other program. There is no main-thread host.

The ABI is chosen from the module's imports:

- WALI: imports from `wali`. Linux to itself. This is what ecmaOS builds its own programs with (`utils/check-wali.sh`).
- WASI Preview 1: imports `wasi_snapshot_preview1`. Built with `wasm32-wasip1` from Rust, wasi-sdk or Go (`GOOS=wasip1 GOARCH=wasm`).
- WASI Preview 2: a component. Built with `wasm32-wasip2`, `wasm-tools component new` or `jco componentize`. Only 0.2 is supported, and the exit status is 0 or 1.
- Emscripten: imports `env.__syscall_*`. A compatibility layer for builds that already exist; build with `emcc` and not `-sSTANDALONE_WASM`.

## Preview 1 and 2 programs

The preopened directories are `/`, `.` and each top-level directory, so a program sees the whole filesystem under its usual paths. The working directory, environment and arguments are the caller's. Standard input and output are the tty, a pipe or a redirection.

## What fails

- A module that exports none of `_start`, `_initialize` or `main` is a library: it is refused with `not a program`.
- A module that imports something the host does not provide fails to start, and the message names the import.
- `fork`, `wasi:http`, WASI 0.3 and `wasi-threads` are not provided. Use `posix_spawn`; WALI programs have POSIX threads.

## Examples

```
$ ./hello.wasm --world
$ ./hello.wasm | wc -c
$ strace ./hello.wasm
```

## Exit status

The program's own. A fault ends it by `SIGABRT`.

## See also

`exec`, `strace`, `ps`, `kill`
