# Third-party licenses

The WebAssembly programs in `programs/` are other people's software, built for ecmaOS. `@ecmaos/coreutils` itself is
MIT OR Apache-2.0; these keep their own licenses, all permissive, and the notices they require are here.

| Program | Version | License | Texts |
|---|---|---|---|
| `bc` (and `dc`) | 7.0.3 | BSD-2-Clause | `bc/LICENSE.md` |
| `dash` | 0.5.12 | BSD-3-Clause | `dash/COPYING` |
| `jq` | 1.8.2 | MIT, with BSD-2-Clause (oniguruma and other parts), the ICU license (decNumber) and David Gay's dtoa license | `jq/COPYING`, `jq/oniguruma-COPYING` |
| `lua` | 5.4.8 | MIT | `lua/LICENSE` |
| `sqlite3` | 3.53.4 | public domain; linenoise is BSD-2-Clause | `sqlite3/blessing.txt`, `sqlite3/linenoise-LICENSE` |
| `bzip2` | 1.0.8 | bzip2-1.0.8 (BSD-style) | `bzip2/LICENSE` |
| `brotli` | 1.2.0 | MIT | `brotli/LICENSE` |
| `xz` | 5.8.4 | 0BSD (the command line tool and liblzma; the GPL scripts are not built) | `xz/COPYING`, `xz/COPYING.0BSD` |
| `zstd` | 1.5.7 | BSD-3-Clause (dual-licensed with GPL-2.0; used under BSD) | `zstd/LICENSE` |
| `mandoc` | 1.14.6 | ISC (with some BSD-2-Clause and BSD-3-Clause files, listed in the text); zlib 1.3.1, built with it, is the zlib license | `mandoc/LICENSE`, `mandoc/zlib-LICENSE` |
| `qjs` | 0.17.0 | MIT | `qjs/LICENSE` |
| `patch` | toybox 0.8.12 (built on WALI's musl) | 0BSD | `patch/LICENSE` |
| `microcom` | toybox 0.8.12 (built on WALI's musl) | 0BSD | `microcom/LICENSE` |
| `hwclock` | toybox 0.8.12 (built on WALI's musl) | 0BSD | `hwclock/LICENSE` |
| `ncdu` | 1.22 | MIT; ncurses is X11 | `ncdu/COPYING`, `ncurses/COPYING` |
| `mg` | 20260719 | public domain, with ISC and BSD parts; ncurses is X11 | `mg/` |
| `micropython` | 1.29.0 | MIT; the frozen micropython-lib modules are MIT or, where derived from CPython, the Python License | `micropython/LICENSE`, `micropython/LICENSE-micropython-lib` |
| `wlcomp` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS) | `wlcomp/LICENSE` |
| `hidinfo` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS) | `hidinfo/LICENSE` |
| `v4l2grab` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS) | `v4l2grab/LICENSE` |
| `wldemo` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS); libwayland 1.26.0 is MIT, libxkbcommon 1.13.2 is MIT, the xdg-shell protocol code is MIT | `wldemo/` |
| `sdlsnake` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS); SDL 3.4.18 is zlib, libwayland 1.26.0 is MIT, libxkbcommon 1.13.2 is MIT, the xdg-shell protocol code is MIT | `sdlsnake/` |
| `sdlpaint` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS); SDL 3.4.18 is zlib, libwayland 1.26.0 is MIT, libxkbcommon 1.13.2 is MIT, the xdg-shell protocol code is MIT | `sdlpaint/` |
| `sdlclip` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS); SDL 3.4.18 is zlib, libwayland 1.26.0 is MIT, libxkbcommon 1.13.2 is MIT, the xdg-shell protocol code is MIT | `sdlclip/` |
| `sdlpad` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS); SDL 3.4.18 is zlib, libwayland 1.26.0 is MIT, libxkbcommon 1.13.2 is MIT, the xdg-shell protocol code is MIT | `sdlpad/` |
| `sdlgl` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS); SDL 3.4.18 is zlib, libwayland 1.26.0 is MIT, libxkbcommon 1.13.2 is MIT, the xdg-shell protocol code is MIT | `sdlgl/` |
| `sdlgears` | 0.1.0 | MIT OR Apache-2.0 (written for ecmaOS); SDL 3.4.18 is zlib, libwayland 1.26.0 is MIT, libxkbcommon 1.13.2 is MIT, the xdg-shell protocol code is MIT | `sdlgears/` |

Every program also contains musl libc and compiler-rt: WALI's musl and LLVM's, or Emscripten's for the desktop
demos. See `runtime/`.

Copyleft programs (GNU make, GNU nano, tree, Vim, ed, lz4, doom) are in `@ecmaos/coreutils-copyleft`, not here.

The build scripts are in `wasm/<name>/build.sh`; `programs/manifest.json` records each program's version, license, size
and sha256, and the toolchains are pinned by `utils/emscripten-version` and `utils/wali-version` in the repository.
