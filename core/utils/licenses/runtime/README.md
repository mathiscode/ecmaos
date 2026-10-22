# What every program here links in

Every program here is built on WALI's musl (its entry in `programs/manifest.json` says `"toolchain": "wali"`;
`utils/check-wali.sh` in the repository), which links:

| Component | License | File |
|---|---|---|
| musl libc, WALI's port of it | MIT (some files carry other permissive licenses, listed in the file) | `wali-musl-COPYRIGHT` |
| WALI, the WebAssembly Linux Interface | MIT | `wali-LICENSE` |
| LLVM compiler-rt (builtins), and in a C++ program libc++, libc++abi and libunwind | Apache-2.0 with LLVM exceptions | `llvm-LICENSE.TXT` |

These notices apply to every program in the package, in addition to its own license in `../<program>/`.
