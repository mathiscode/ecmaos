#!/usr/bin/env bash
# Rebuilds programs/lua.wasm: the Lua 5.4 interpreter for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by
# /bin/wali. The result is committed, so only run this to change it.
# No readline (the terminal's own line discipline edits the line) and no dlopen, so `require` finds Lua
# modules only; everything else in the standard library is there.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=5.4.8
SHA256=4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/lua.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o lua.tar.gz "https://www.lua.org/ftp/lua-$VERSION.tar.gz"
echo "$SHA256  lua.tar.gz" | sha256sum -c -
tar xzf lua.tar.gz
cd "lua-$VERSION/src"

SOURCES=$(ls *.c | grep -v '^luac\.c$')
"$WALI_CC" -O2 -DLUA_USE_POSIX $SOURCES -o lua.wasm -lm \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp lua.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
