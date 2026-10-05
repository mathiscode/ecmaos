# What every program here links in

Each `.wasm` is built with Emscripten, which links its C library and support code into the binary:

| Component | License | File |
|---|---|---|
| musl libc | MIT (some files carry other permissive licenses, listed in the file) | `musl-COPYRIGHT` |
| LLVM compiler-rt (builtins) | Apache-2.0 with LLVM exceptions | `llvm-LICENSE.TXT` |
| dlmalloc, Emscripten's `malloc` | Public domain / CC0, by Doug Lea | (no license text; the source says it is released to the public domain, <http://creativecommons.org/publicdomain/zero/1.0/>) |

These notices apply to every program in the package, in addition to its own license in `../<program>/`.
