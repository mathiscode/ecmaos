#!/usr/bin/env bash
# Rebuilds programs/sqlite3.wasm: the SQLite command-line shell for ecmaOS, on WALI's musl (`utils/check-wali.sh`),
# run by /bin/wali.
#
# Needs `unzip`. The result is committed, so only run this to change it.
#
#  - Single-threaded and with no loadable extensions (no `dlopen`), which is also what keeps the module small.
#  - FTS5, JSON, math functions and the `dbstat` virtual table are compiled in.
#  - No mmap (`SQLITE_MAX_MMAP_SIZE=0`): a shared mapping here is a copy kept in step at system calls, so SQLite
#    reads and writes the file itself.
#  - Line editing and history come from linenoise (BSD, pinned below): the terminal is in cooked mode, which would
#    echo an arrow key as raw escape bytes. History is kept in ~/.sqlite_history, as the real shell does.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=3530400
YEAR=2026
SHA3_256=628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e
LINENOISE=a473823d74b93eab2ba83480df16ed37617493f2
LINENOISE_SHA256=3db03aba739bc96f3da3133b9615ccc43246ba2c3628b403b00a470abd3b6a8d
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/sqlite3.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o sqlite.zip "https://sqlite.org/$YEAR/sqlite-amalgamation-$VERSION.zip"
echo "$SHA3_256  sqlite.zip" > sum.txt
[ "$(openssl dgst -sha3-256 sqlite.zip | awk '{print $NF}')" = "$SHA3_256" ] || { echo "sha3-256 mismatch" >&2; exit 1; }
unzip -q sqlite.zip
curl -fsSL -o linenoise.tar.gz "https://github.com/antirez/linenoise/archive/$LINENOISE.tar.gz"
echo "$LINENOISE_SHA256  linenoise.tar.gz" | sha256sum -c -
tar xzf linenoise.tar.gz
cd "sqlite-amalgamation-$VERSION"
cp ../linenoise-$LINENOISE/linenoise.[ch] .

"$WALI_CC" -O2 -Wno-implicit-const-int-float-conversion \
  -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS \
  -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_DQS=0 -DHAVE_USLEEP=1 -DSQLITE_MAX_MMAP_SIZE=0 -DHAVE_LINENOISE=1 \
  shell.c sqlite3.c linenoise.c -o sqlite3.wasm -lm \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp sqlite3.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
