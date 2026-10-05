#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/tree.wasm: `tree`, the directory listing, for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
# Built like the other emcc programs (see ../vim/build.sh): `-sSTANDALONE_WASM=0` so the module imports the
# real `env.__syscall_*` calls that `core/kernel/src/bin/wasi-preview1.mjs` answers.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version tree)
ARCHIVE=$(node "$SOURCES" fetch tree)
OUT=$HERE/../../programs/tree.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "tree-$VERSION"

emcc -O2 -DLINUX -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 tree.c list.c hash.c color.c file.c filter.c info.c unix.c xml.c json.c html.c strverscmp.c -o tree.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp tree.wasm "$OUT"
ls -l "$OUT"
