# @ecmaos-apps/tsc

`tsc` for ecmaOS: the TypeScript compiler, as [tsrs](https://github.com/oxc-project/tsrs) (a Rust port of TypeScript 7)
built to WebAssembly. It type-checks and emits JavaScript and declarations from the machine's own files.

```
install @ecmaos-apps/tsc
tsc --noEmit src/index.ts
tsc --outDir dist --declaration src/index.ts
```

`install` also installs `@tsrs/wasm`, which this package depends on at one exact version; the compiler is its
`tsrs.wasm` (9.8 MB), read from `/usr/lib/@tsrs/wasm/<version>/`. tsrs is Apache-2.0 and a derivative of TypeScript
(Microsoft); its `LICENSE` and `NOTICE.txt` are installed beside it. Set `TSRS_WASM` to run another build.

tsrs is experimental. There is no `--watch`, `--init` or `--showConfig`, and the compiler is single-threaded.
