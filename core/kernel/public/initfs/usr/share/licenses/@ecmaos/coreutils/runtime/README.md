# What every program here links in

The Wayland compositor `wlcomp` is built with Emscripten, which links its C library and support code into the binary:

| Component | License | File |
|---|---|---|
| musl libc | MIT (some files carry other permissive licenses, listed in the file) | `musl-COPYRIGHT` |
| LLVM compiler-rt (builtins) | Apache-2.0 with LLVM exceptions | `llvm-LICENSE.TXT` |
| dlmalloc, Emscripten's `malloc` | Public domain / CC0, by Doug Lea | (no license text; the source says it is released to the public domain, <http://creativecommons.org/publicdomain/zero/1.0/>) |

The other programs, whose entries in `programs/manifest.json` say `"toolchain": "wali"`, are built on WALI's musl
(`utils/check-wali.sh` in the repository), which links:

| Component | License | File |
|---|---|---|
| musl libc, WALI's port of it | MIT (some files carry other permissive licenses, listed in the file) | `wali-musl-COPYRIGHT` |
| WALI, the WebAssembly Linux Interface | MIT | `wali-LICENSE` |
| LLVM compiler-rt (builtins), and in a C++ program libc++, libc++abi and libunwind | Apache-2.0 with LLVM exceptions | `llvm-LICENSE.TXT` |

These notices apply to every program in the package, in addition to its own license in `../<program>/`.
