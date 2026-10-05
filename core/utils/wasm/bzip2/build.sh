#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/bzip2.wasm: bzip2 (and bunzip2, bzcat: links to it) for ecmaOS, with emscripten.
# Built like the other emcc programs (see ../../../utils-copyleft/wasm/vim/build.sh): `-sSTANDALONE_WASM=0` so the
# module imports the real `env.__syscall_*` calls that `core/kernel/src/bin/wasi-preview1.mjs` answers, and wasm
# exceptions for setjmp. The source is unmodified.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

VERSION=1.0.8
SHA256=ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/bzip2.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o bzip2.tar.gz "https://sourceware.org/pub/bzip2/bzip2-$VERSION.tar.gz"
echo "$SHA256  bzip2.tar.gz" | sha256sum -c -
tar xzf bzip2.tar.gz
cd "bzip2-$VERSION"

emcc -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -D_FILE_OFFSET_BITS=64 \
  bzip2.c blocksort.c huffman.c crctable.c randtable.c compress.c decompress.c bzlib.c -o bzip2.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp bzip2.wasm "$OUT"
ls -l "$OUT"
