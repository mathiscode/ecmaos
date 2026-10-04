#!/usr/bin/env bash
# Rebuilds src/bin/wasm/tree.wasm: `tree`, the directory listing, for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
# Built like the other emcc programs (see ../vim/build.sh): `-sSTANDALONE_WASM=0` so the module imports the
# real `env.__syscall_*` calls that `src/bin/wasi-preview1.mjs` answers.
set -euo pipefail

VERSION=2.2.1
SHA256=5caddcbca805131ff590b126d3218019882e4ca10bc9eb490bba51c05b9b3b75
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../src/bin/wasm/tree.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o tree.tar.gz "https://github.com/Old-Man-Programmer/tree/archive/refs/tags/$VERSION.tar.gz"
echo "$SHA256  tree.tar.gz" | sha256sum -c -
tar xzf tree.tar.gz
cd "tree-$VERSION"

emcc -O2 -DLINUX -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 tree.c list.c hash.c color.c file.c filter.c info.c unix.c xml.c json.c html.c strverscmp.c -o tree.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp tree.wasm "$OUT"
ls -l "$OUT"
