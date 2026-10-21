#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/make.wasm: GNU make 4.4.1 for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it. Built like the other emcc
# programs (see ../vim/build.sh), from the source unmodified. There is no fork: make starts its jobs with posix_spawn,
# which libecmaos (`core/utils/wasm/lib/ecmaos.sh`) gives it along with waitpid and SIGCHLD, so `-j` runs jobs side by
# side. configure cannot run its test of posix_spawn here (it runs the program under node, where the host's calls are
# stubs), so it is told the answer: a program that does not exist fails in the call, with ENOENT. Without pselect
# (`ac_cv_func_pselect=no`) make waits for a jobserver token with a read that its SIGCHLD handler interrupts, which is
# the signal path libecmaos has. There are no fifos, so the jobserver is a pipe (`JOBSERVER_USE_FIFO=0`), as before
# make 4.4.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"
source "$(dirname "$0")/../../../utils/wasm/lib/ecmaos.sh"

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

build_ecmaos "$WORK"

FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -DJOBSERVER_USE_FIFO=0"
LINK="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush $ECMAOS_LDFLAGS $ECMAOS_LIB"
CC=emcc CFLAGS="$FLAGS" LDFLAGS="$LINK" ac_cv_func_pselect=no make_cv_synchronous_posix_spawn=yes ./configure --host=wasm32-unknown-emscripten --without-guile \
  --disable-nls --disable-load --disable-dependency-tracking > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
grep -q '^#define USE_POSIX_SPAWN 1' src/config.h || { echo "make: configure did not find posix_spawn" >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp make.wasm "$OUT"
ls -l "$OUT"
