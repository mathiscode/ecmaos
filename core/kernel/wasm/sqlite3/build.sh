#!/usr/bin/env bash
# Rebuilds src/bin/wasm/sqlite3.wasm: the SQLite command-line shell for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6) and `unzip`. The result is committed, so only run this to change it.
# It is built like the other emcc programs (see ../vim/build.sh): `-sSTANDALONE_WASM=0`, so the module
# imports the real `env.__syscall_*` calls that `src/bin/wasi-preview1.mjs` answers.
#
#  - Single-threaded and with no loadable extensions (no `dlopen`), which is also what keeps the module small.
#  - FTS5, JSON, math functions and the `dbstat` virtual table are compiled in.
#  - No mmap (`SQLITE_MAX_MMAP_SIZE=0`): the shim has no `mmap`, and SQLite reads and writes the file itself.
#  - No readline: the shell reads its input a line at a time from the terminal, which already edits it.
set -euo pipefail

VERSION=3530400
YEAR=2026
SHA3_256=628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../src/bin/wasm/sqlite3.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o sqlite.zip "https://sqlite.org/$YEAR/sqlite-amalgamation-$VERSION.zip"
echo "$SHA3_256  sqlite.zip" > sum.txt
[ "$(openssl dgst -sha3-256 sqlite.zip | awk '{print $NF}')" = "$SHA3_256" ] || { echo "sha3-256 mismatch" >&2; exit 1; }
unzip -q sqlite.zip
cd "sqlite-amalgamation-$VERSION"

emcc -O2 -Wno-implicit-const-int-float-conversion \
  -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS \
  -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_DQS=0 -DHAVE_USLEEP=0 -DSQLITE_MAX_MMAP_SIZE=0 \
  shell.c sqlite3.c -o sqlite3 \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush
cp sqlite3.wasm "$OUT"
ls -l "$OUT"
