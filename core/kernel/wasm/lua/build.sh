#!/usr/bin/env bash
# Rebuilds src/bin/wasm/lua.wasm: the Lua 5.4 interpreter for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
# Built like the other emcc programs (see ../vim/build.sh): `-sSTANDALONE_WASM=0` so the module imports the
# real `env.__syscall_*` calls that `src/bin/wasi-preview1.mjs` answers, and wasm exceptions for setjmp.
# No readline (the terminal's own line discipline edits the line) and no dlopen, so `require` finds Lua
# modules only; everything else in the standard library is there.
set -euo pipefail

VERSION=5.4.8
SHA256=4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../src/bin/wasm/lua.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o lua.tar.gz "https://www.lua.org/ftp/lua-$VERSION.tar.gz"
echo "$SHA256  lua.tar.gz" | sha256sum -c -
tar xzf lua.tar.gz
cd "lua-$VERSION/src"

SOURCES=$(ls *.c | grep -v '^luac\.c$')
emcc -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -DLUA_USE_POSIX $SOURCES -o lua.js \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp lua.wasm "$OUT"
ls -l "$OUT"
