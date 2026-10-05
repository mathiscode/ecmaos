#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/brotli.wasm: the brotli command-line tool for ecmaOS, with emscripten.
# Built like the other emcc programs (see ../zstd/build.sh): the encoder, decoder and common code plus tools/brotli.c, all
# unmodified. brotli is MIT.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

VERSION=1.2.0
SHA256=816c96e8e8f193b40151dad7e8ff37b1221d019dbcb9c35cd3fadbfe6477dfec
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/brotli.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o brotli.tar.gz "https://github.com/google/brotli/archive/refs/tags/v$VERSION.tar.gz"
echo "$SHA256  brotli.tar.gz" | sha256sum -c -
tar xzf brotli.tar.gz
cd "brotli-$VERSION"

emcc -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -D_FILE_OFFSET_BITS=64 -Ic/include \
  c/common/*.c c/dec/*.c c/enc/*.c c/tools/brotli.c -o brotli.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp brotli.wasm "$OUT"
ls -l "$OUT"
