# wasm

`man @ecmaos/coreutils/wasm`

## Synopsis

```
./PROGRAM.wasm [ARG]...
wasm info FILE...
```

## Description

How ecmaOS runs a WebAssembly file, and `wasm info`, which says what it would do with one. Any file that starts with the WebAssembly magic bytes is run by `execve`, in a worker of its own, as a process with a pid, signals, a controlling terminal and an exit status. Pipes, redirections, job control (`^C`, `^Z`, `bg`, `fg`) and `ps`, `kill` and `strace` work on it as on any other program. There is no main-thread host.

The ABI is chosen from the module's imports:

- WALI: imports from `wali`. Linux to itself. This is what ecmaOS builds its own programs with (`utils/check-wali.sh`).
- WASI Preview 1: imports `wasi_snapshot_preview1`. Built with `wasm32-wasip1` from Rust, wasi-sdk or Go (`GOOS=wasip1 GOARCH=wasm`).
- WASI Preview 2: a component. Built with `wasm32-wasip2`, `wasm-tools component new` or `jco componentize`. Only 0.2 is supported, and the exit status is 0 or 1.
- Emscripten: imports `env.__syscall_*`. A compatibility layer for builds that already exist; build with `emcc` and not `-sSTANDALONE_WASM`.

## wasm info

`wasm info FILE...` names the ABI of each file, says whether it is a program (and where it starts), and lists the imports ecmaOS does not provide. The file is not run: `/bin/wali` is started on it with `ECMAOS_WASM_INFO` set and reports from the same tables a run uses, so what it calls not provided is what a run would stop at.

```
$ wasm info ./hello.wasm
./hello.wasm
  ABI: WASI Preview 1
  Runs as: a program, started at _start
  Imports: 9 functions from wasi_snapshot_preview1
  Not provided: none
```

An import listed as not provided stops the program with a message naming it, but only if the program calls it. For a component, one it needs and is not provided stops it at start. The exit status is 1 if a file could not be read or described.

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
$ wasm info ./hello.wasm
```

## Exit status

The program's own. A fault ends it by `SIGABRT`. `wasm info` exits 0 if every file was described, 1 otherwise.

## See also

`exec`, `strace`, `ps`, `kill`
