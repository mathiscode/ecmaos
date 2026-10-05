#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/mandoc.wasm: mandoc, the man(7) and mdoc(7) formatter, for ecmaOS, with emscripten.
# mandoc has its own configure script, driven here by a configure.local; the source is unmodified. Built without the man
# page database (apropos, makewhatis) and the CGI program: only the formatter, with its terminal, HTML, Markdown and
# lint output. The one library is zlib, from emscripten's port, so a gzipped page can be read.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

VERSION=1.14.6
SHA256=8bf0d570f01e70a6e124884088870cbed7537f36328d512909eb10cd53179d9c
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/mandoc.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o mandoc.tar.gz "https://mandoc.bsd.lv/snapshots/mandoc-$VERSION.tar.gz"
echo "$SHA256  mandoc.tar.gz" | sha256sum -c -
tar xzf mandoc.tar.gz
cd "mandoc-$VERSION"

cat > configure.local <<'CONF'
CC=emcc
CFLAGS="-sUSE_ZLIB=1 -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
LDFLAGS="-sUSE_ZLIB=1 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_main,_fflush"
PREFIX=/usr
MANDIR=/usr/share/man
BUILD_DB=0
BUILD_CGI=0
HAVE_MANPATH=0
CONF
./configure > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" mandoc > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp mandoc.wasm "$OUT"
ls -l "$OUT"
