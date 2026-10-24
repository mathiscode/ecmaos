# @ecmaos/coreutils-copyleft

Copyleft programs for ecmaOS, built to WebAssembly: GNU Bash, GNU make, GNU nano (with ncurses), GNU ed, lz4, tree, Vim and Doom. They live apart
from `@ecmaos/coreutils` (MIT OR Apache-2.0) so that package, and the kernel, carry no copyleft code. The ecmaOS
site serves these programs as separate files under `/programs/`; nothing in the kernel bundle contains them.

Each program runs as a process of its own, started with `execve`, and talks to the rest of the system only through
syscalls, arguments and pipes. The programs are never imported as libraries.

## Licenses

| Program | License | Notes |
|---|---|---|
| `bash` 5.3 | GPL-3.0-or-later | statically linked with its bundled readline and termcap; forks, so it is built with Asyncify |
| `make` 4.4.1 | GPL-3.0-or-later | |
| `nano` 9.2 | GPL-3.0-or-later | statically linked with ncurses 6.5 (X11 license) |
| `ed` 1.22.5 | GPL-2.0-or-later | |
| `lz4` 1.10.0 | GPL-2.0-or-later | the command line tool; liblz4, linked in, is BSD-2-Clause |
| `tree` 2.2.1 | GPL-2.0-or-later | |
| `vim` 9.1.0 | Vim license | a modified version: see `licenses/vim/SOURCE`; `:version` and the intro screen say so |
| `doom` 0.1.0 | GPL-2.0-or-later | doomgeneric (the Doom source release), statically linked with SDL 3.4.18 (zlib license), libwayland 1.26.0 and libxkbcommon 1.13.2 (MIT); SDL and the two libraries are built by the scripts in `@ecmaos/coreutils` (`wasm/lib/`); no game data |

Each binary also contains musl libc and compiler-rt (see `licenses/runtime/`). Files written for ecmaOS in this
package are licensed as the program they belong to when they modify or are linked into it
(`wasm/doom/doomecma.c` and `doomsound.c`: GPL-2.0-or-later), and otherwise MIT OR Apache-2.0 (the scripts); each
carries an `SPDX-License-Identifier`. `vim` is also linked with a termcap from `@ecmaos/coreutils`
(`wasm/lib/ecmaos/termcap.c`, MIT OR Apache-2.0). The texts are in `licenses/`.

## Source

`programs/manifest.json` pins the upstream archive of every program (URL and sha256). `node scripts/sources.mjs all`
downloads them into `sources/`, which is what `npm pack` ships and what a deployment serves at `/sources/`, so the
source offered is the source the binary was built from. `licenses/<program>/SOURCE` is the written offer for each
program: the upstream archive, what ecmaOS changed, and the toolchain (`utils/wali-version` in the repository).

## Rebuilding

`wasm/<name>/build.sh` rebuilds one program and writes `programs/<name>.wasm` on WALI's musl (`utils/check-wali.sh`
builds the pinned sysroot the first time; it wants the pinned clang unless `ECMAOS_WALI_ANY=1`). Then `node ../../utils/programs-manifest.mjs` refreshes the
manifest's sizes and hashes. `wasm/vim/runtime.sh` packs the subset of Vim's runtime that ships into
`programs/vim-runtime.tar.gz` (Vim-licensed files, so they travel with `vim` and not with the kernel's initfs). It is
listed under `vim.runtime` in the manifest, and the kernel unpacks it to `/usr/share/vim/vim91` beside the program.
