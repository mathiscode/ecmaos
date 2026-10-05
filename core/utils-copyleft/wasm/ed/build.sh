#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/ed.wasm: GNU ed, the line editor, for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
# Built like the other emcc programs (see ../vim/build.sh): `-sSTANDALONE_WASM=0` so the module imports the
# real `env.__syscall_*` calls that `core/kernel/src/bin/wasi-preview1.mjs` answers. ed's own configure script only
# writes a Makefile, so the eight source files are compiled directly; the source is unmodified.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version ed)
ARCHIVE=$(node "$SOURCES" fetch ed)
OUT=$HERE/../../programs/ed.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "ed-$VERSION"

emcc -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -D_FILE_OFFSET_BITS=64 -DPROGVERSION="\"$VERSION\"" \
  buffer.c carg_parser.c global.c io.c main.c main_loop.c regex.c signal.c -o ed.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp ed.wasm "$OUT"
ls -l "$OUT"
