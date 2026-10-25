# tsc

`man @ecmaos-apps/tsc/tsc`

## Synopsis

```
tsc [OPTIONS] [FILE]...
```

## Description

The TypeScript compiler, as tsrs: a Rust port of TypeScript 7, built to WebAssembly. It type-checks and emits JavaScript and declarations from the machine's files, and takes tsc's own options (`-p`, `--noEmit`, `--outDir`, `--declaration`, `--strict`, `-b`, and the rest; `tsc --all` lists them). It exits 0 when there is nothing to report and 2 when there are errors.

Install it with `install @ecmaos-apps/tsc`, which also installs `@tsrs/wasm`, the package that holds the compiler (9.8 MB, in `/usr/lib/@tsrs/wasm/<version>/`). tsrs is Apache-2.0 and a derivative of TypeScript (Microsoft); its `LICENSE` and `NOTICE.txt` are installed beside it.

## Options

- `--json-diagnostics` - print the diagnostics as JSON
- `-h`, `--help` - display usage and exit

## Environment

- `TSRS_WASM` - the `tsrs.wasm` to run instead of the installed one

## Limits

tsrs is experimental. There is no `--watch`, `--init` or `--showConfig`; the compiler is single-threaded, and a deeply recursive type can overflow its stack.

## Examples

```
tsc --noEmit src/index.ts
tsc --outDir dist --declaration src/index.ts
tsc -p .
```
