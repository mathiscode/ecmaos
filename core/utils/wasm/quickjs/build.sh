#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/qjs.wasm: the QuickJS-ng JavaScript interpreter (`qjs`: script runner and REPL) for ecmaOS, with
# emscripten. Built like the other emcc programs (see ../../../utils-copyleft/wasm/vim/build.sh), from the sources
# unmodified, with the std and os modules (QJS_BUILD_LIBC). `os.exec` and `os.Worker` need fork and threads, which
# are not available here; everything else in std and os is.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

VERSION=0.17.0
SHA256=559bc4c420475e55c7ab4510adbc562f55d7524d75e8e89d79ce4bb02f5687d9
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/qjs.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o quickjs.tar.gz "https://github.com/quickjs-ng/quickjs/archive/refs/tags/v$VERSION.tar.gz"
echo "$SHA256  quickjs.tar.gz" | sha256sum -c -
tar xzf quickjs.tar.gz
cd "quickjs-$VERSION"

emcc -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -D_GNU_SOURCE -DQJS_BUILD_LIBC \
  dtoa.c libregexp.c libunicode.c quickjs.c quickjs-libc.c gen/repl.c gen/standalone.c qjs.c -o qjs.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp qjs.wasm "$OUT"
ls -l "$OUT"
