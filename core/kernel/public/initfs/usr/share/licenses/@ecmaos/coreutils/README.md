# Third-party licenses

The WebAssembly programs in `programs/` are other people's software, built for ecmaOS. `@ecmaos/coreutils` itself is
MIT OR Apache-2.0; these keep their own licenses, all permissive, and the notices they require are here.

| Program | Version | License | Texts |
|---|---|---|---|
| `bc` (and `dc`) | 7.0.3 | BSD-2-Clause | `bc/LICENSE.md` |
| `jq` | 1.8.2 | MIT, with BSD-2-Clause (oniguruma and other parts), the ICU license (decNumber) and David Gay's dtoa license | `jq/COPYING`, `jq/oniguruma-COPYING` |
| `lua` | 5.4.8 | MIT | `lua/LICENSE` |
| `sqlite3` | 3.53.4 | public domain; linenoise is BSD-2-Clause | `sqlite3/blessing.txt`, `sqlite3/linenoise-LICENSE` |
| `bzip2` | 1.0.8 | bzip2-1.0.8 (BSD-style) | `bzip2/LICENSE` |
| `xz` | 5.8.4 | 0BSD (the command line tool and liblzma; the GPL scripts are not built) | `xz/COPYING`, `xz/COPYING.0BSD` |
| `zstd` | 1.5.7 | BSD-3-Clause (dual-licensed with GPL-2.0; used under BSD) | `zstd/LICENSE` |
| `qjs` | 0.17.0 | MIT | `qjs/LICENSE` |
| `patch` | toybox 0.8.12 | 0BSD | `patch/LICENSE` |
| `ncdu` | 1.22 | MIT; ncurses is X11 | `ncdu/COPYING`, `ncurses/COPYING` |
| `mg` | 20260719 | public domain, with ISC and BSD parts; ncurses is X11 | `mg/` |
| `micropython` | 1.29.0 | MIT; the frozen micropython-lib modules are MIT or, where derived from CPython, the Python License | `micropython/LICENSE`, `micropython/LICENSE-micropython-lib` |

Every program also contains musl libc and compiler-rt, from Emscripten: see `runtime/`.

Copyleft programs (GNU make, GNU nano, tree, Vim) are in `@ecmaos/coreutils-copyleft`, not here.

The build scripts are in `wasm/<name>/build.sh`; `programs/manifest.json` records each program's version, license, size
and sha256, and the toolchain is pinned by `utils/emscripten-version` in the repository.
