#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/make.wasm: GNU make 4.4.1 for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it. Built like the other emcc
# programs (see ../vim/build.sh). There is no fork, so `ecmaos-spawn.c` (linked in, and called from a patched
# `child_execute_job`) runs each recipe line to completion through system(); make therefore runs one job at a time.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version make)
ARCHIVE=$(node "$SOURCES" fetch make)
OUT=$HERE/../../programs/make.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "make-$VERSION"

# The vfork branch of child_execute_job becomes a synchronous run; the rest of that branch is then unreachable.
python3 - <<'PY'
p = 'src/job.c'
s = open(p).read()
old = "    pid = vfork ();\n    if (pid != 0)"
assert old in s, "make source changed: vfork call not found"
s = s.replace(old, "    extern pid_t ecmaos_run (char **, int);\n    pid = ecmaos_run (argv, fdout);\n    if (1)")
s = s.replace("pid_t\nchild_execute_job (struct childbase *child, int good_stdin, char **argv)\n{", "pid_t\nchild_execute_job (struct childbase *child, int good_stdin, char **argv)\n{", 1)
open(p, 'w').write(s)
PY
cp "$HERE/ecmaos-spawn.c" src/ecmaos-spawn.c

FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
LINK="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush"
CC=emcc CFLAGS="$FLAGS" LDFLAGS="$LINK" ./configure --host=wasm32-unknown-emscripten --without-guile --disable-nls \
  --disable-load --disable-posix-spawn --disable-dependency-tracking > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
emcc $FLAGS -c src/ecmaos-spawn.c -o src/ecmaos-spawn.o
make -j"$(nproc)" LIBS="$PWD/src/ecmaos-spawn.o" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp make.wasm "$OUT"
ls -l "$OUT"
