#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/lz4.wasm: the lz4 command-line tool (and unlz4, lz4cat, links to it) for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
# Built like the other emcc programs (see ../vim/build.sh). The command line tool is GPL-2.0-or-later (liblz4, linked
# in, is BSD-2-Clause), which is why this is in the copyleft package and not beside zstd. Single-threaded
# (`LZ4IO_MULTITHREAD=0`); the source is unmodified.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version lz4)
ARCHIVE=$(node "$SOURCES" fetch lz4)
OUT=$HERE/../../programs/lz4.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "lz4-$VERSION"

emcc -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -D_FILE_OFFSET_BITS=64 -DLZ4IO_MULTITHREAD=0 -Ilib -Iprograms \
  lib/lz4.c lib/lz4hc.c lib/lz4frame.c lib/xxhash.c programs/bench.c programs/lz4cli.c programs/lz4io.c programs/lorem.c \
  programs/threadpool.c programs/timefn.c programs/util.c -o lz4.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp lz4.wasm "$OUT"
ls -l "$OUT"
