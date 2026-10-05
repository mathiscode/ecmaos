#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/xz.wasm: xz (and unxz, xzcat, lzma, unlzma, lzcat: links to it) for ecmaOS, with emscripten.
# Built like the other emcc programs (see ../../../utils-copyleft/wasm/vim/build.sh). No threads (`--disable-threads`,
# so `-T` is accepted and runs single-threaded), no shell scripts (xzdiff and friends are GPL and need fork), no
# liblzma shared library. The source is unmodified; the command line tool and liblzma are 0BSD.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

VERSION=5.8.4
SHA256=0014c7886930454fe8bd4228665b51af55eeae560ea135c9c4cd33f55b2591d9
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/xz.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o xz.tar.gz "https://github.com/tukaani-project/xz/releases/download/v$VERSION/xz-$VERSION.tar.gz"
echo "$SHA256  xz.tar.gz" | sha256sum -c -
tar xzf xz.tar.gz
cd "xz-$VERSION"

FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared --enable-static --disable-threads --disable-nls \
  --disable-scripts --disable-doc --disable-xzdec --disable-lzmadec --disable-lzmainfo --disable-symbol-versions \
  CFLAGS="$FLAGS" > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
emmake make -j"$(nproc)" -C src/liblzma > make-lib.log 2>&1 || { tail -30 make-lib.log >&2; exit 1; }
emmake make -j"$(nproc)" -C src/xz xz LDFLAGS="$FLAGS -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_main,_fflush" \
  > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp src/xz/xz.wasm "$OUT"
ls -l "$OUT"
