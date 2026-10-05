# Third-party licenses

The WebAssembly programs in `programs/` are other people's software, built for ecmaOS. `@ecmaos/coreutils` itself is
MIT OR Apache-2.0; these keep their own licenses, all permissive, and the notices they require are here.

| Program | Version | License | Texts |
|---|---|---|---|
| `bc` (and `dc`) | 7.0.3 | BSD-2-Clause | `bc/LICENSE.md` |
| `jq` | 1.8.2 | MIT, with BSD-2-Clause (oniguruma and other parts), the ICU license (decNumber) and David Gay's dtoa license | `jq/COPYING`, `jq/oniguruma-COPYING` |
| `lua` | 5.4.8 | MIT | `lua/LICENSE` |
| `sqlite3` | 3.53.4 | public domain; linenoise is BSD-2-Clause | `sqlite3/blessing.txt`, `sqlite3/linenoise-LICENSE` |

Every program also contains musl libc and compiler-rt, from Emscripten: see `runtime/`.

Copyleft programs (GNU make, GNU nano, tree, Vim) are in `@ecmaos/coreutils-copyleft`, not here.

The build scripts are in `wasm/<name>/build.sh`; `programs/manifest.json` records each program's version, license, size
and sha256, and the toolchain is pinned by `utils/emscripten-version` in the repository.
