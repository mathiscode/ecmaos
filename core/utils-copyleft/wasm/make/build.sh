#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/make.wasm: GNU make 4.4.1 for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali.
#
# The result is committed, so only run this to change it. Built from the source unmodified. There is no fork: make
# starts its jobs with posix_spawn, and waits for them with waitpid and SIGCHLD, so `-j` runs jobs side by side. Its
# main, which takes the environment as well, is called from one that passes it (see below).
# configure cannot run its test of posix_spawn here (the program it builds does not run on this machine), so it is told
# the answer: a program that does not exist fails in the call, with ENOENT. Without pselect (`ac_cv_func_pselect=no`)
# make waits for a jobserver token with a read that its SIGCHLD handler interrupts. There are no fifos, so the
# jobserver is a pipe (`JOBSERVER_USE_FIFO=0`), as before make 4.4.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

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

CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS="-O2 -DJOBSERVER_USE_FIFO=0" \
  ac_cv_func_pselect=no make_cv_synchronous_posix_spawn=yes ./configure --host=wasm32-unknown-linux-musl --without-guile \
  --disable-nls --disable-load --disable-dependency-tracking > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
grep -q '^#define USE_POSIX_SPAWN 1' src/config.h || { echo "make: configure did not find posix_spawn" >&2; exit 1; }
# make's main takes the environment as a third argument, which WALI's start does not pass: it calls a main of argc and
# argv (which clang names __main_argc_argv on wasm). So main.c is compiled with its main renamed, and a main that
# passes environ calls it.
grep -q '^main (int argc, char \*\*argv, char \*\*envp)$' src/main.c || { echo "make's main changed: it no longer takes envp" >&2; exit 1; }
make src/main.o CFLAGS="-O2 -DJOBSERVER_USE_FIFO=0 -Dmain=make_main" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cat > src/wali-main.c <<'C'
extern char **environ;
int make_main(int argc, char **argv, char **envp);
int main(int argc, char **argv) { return make_main(argc, argv, environ); }
C
"$WALI_CC" -O2 -c src/wali-main.c -o src/wali-main.o
make -j"$(nproc)" LIBS="src/wali-main.o $(sed -n 's/^LIBS = //p' Makefile)" >> make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp make "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
