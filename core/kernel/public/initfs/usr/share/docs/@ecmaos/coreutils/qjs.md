# qjs

`man @ecmaos/coreutils/qjs`

## Synopsis

```
qjs [-e EXPR] [-I FILE] [-m] [--std] [FILE [ARGS...]]
```

## Description

QuickJS-ng 0.17, a small and complete JavaScript engine (ES2023 and later). With no file it is an interactive REPL; with a file it runs a script or module (`.mjs`). The `qjs:std` and `qjs:os` modules give files, environment, time and timers; `scriptArgs` holds the arguments. `os.exec` starts a program (with `posix_spawn`: the `uid`, `gid` and `groups` options are not supported) and `os.Worker` runs a worker on a thread of its own.

## Examples

```
qjs -e 'console.log(2 ** 64n)'
qjs script.mjs arg1 arg2
qjs   # REPL
```

## License

MIT. The license text is in `/usr/share/licenses/@ecmaos/coreutils/qjs/`.
