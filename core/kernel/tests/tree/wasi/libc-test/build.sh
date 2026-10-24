#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds libc-test.wasm: musl's libc-test (MIT; https://wiki.musl-libc.org/libc-test), its functional and regression
# tests, built on WALI's musl with the pinned toolchain (utils/check-wali.sh) into one program (runner.c). Each test's
# main is renamed, and tests.h, written here, lists them. Left out: the tests of dynamic linking (dlopen and the
# shared objects the TLS tests load), which a static program cannot have, and the four of thread cancellation, which
# WALI's musl does not have (pthread_cancel needs the cancellation points of an architecture's assembly). A test that
# replaces part of libc (flockfile-list brings its own malloc), or whose main ends without a return (which is 0 only
# for a function called main), is a program of its own, <dir>.<name>.wasm, beside it (so is raise-race, which forks in a signal
# handler and is built to unwind at every import for that, see utils/wali/asyncify.sh). The source is a git checkout of the commit
# below, which git verifies. `../libc-test.test.ts` runs the result; `expected-failures.txt` lists what fails today.
set -euo pipefail
source "$(dirname "$0")/../../../../../../utils/check-wali.sh"

COMMIT=7b95dfa5f5d5ca4d949221e0228ccc290bacc14e
REPOSITORIES="https://repo.or.cz/libc-test.git git://repo.or.cz/libc-test.git"
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# repo.or.cz resets connections now and then, so the clone is tried a few times over both protocols; the checkout of
# the commit is what makes the source the right one
for attempt in 1 2 3; do
  for repository in $REPOSITORIES; do
    git clone -q "$repository" "$WORK/libc-test" 2> /dev/null && break 2
    rm -rf "$WORK/libc-test"
  done
  [ "$attempt" = 3 ] && { echo "libc-test: could not clone $REPOSITORIES" >&2; exit 1; }
  sleep 2
done
git -C "$WORK/libc-test" checkout -q "$COMMIT"
cd "$WORK/libc-test"

# libc-test's own flags (Makefile and config.mak.def), less what only GCC or glibc takes
CFLAGS="-O2 -std=c99 -D_POSIX_C_SOURCE=200809L -D_FILE_OFFSET_BITS=64 -fno-builtin -frounding-math -w -Isrc/common"

mkdir -p "$WORK/obj"
for source in src/common/*.c; do
  case $source in src/common/runtest.c) continue ;; esac
  "$WALI_CC" $CFLAGS -c "$source" -o "$WORK/obj/common-$(basename "${source%.c}").o"
done

: > "$WORK/tests.h"
table=""
for source in src/functional/*.c src/regression/*.c; do
  name=$(basename "${source%.c}")
  case $name in dlopen*|*_dlopen|*_dso|tls_align|tls_get_new-dtv) continue ;; esac
  case $name in pthread_cancel|pthread_cancel-points|pthread_cancel-sem_wait|pthread_cond_wait-cancel_ignored) continue ;; esac
  dir=$(basename "$(dirname "$source")")
  test=$dir.$name
  symbol=lt_$(echo "$test" | tr -c 'A-Za-z0-9_\n' '_')
  if [ "$name" = flockfile-list ] || [ "$name" = raise-race ] || ! "$WALI_CC" ${CFLAGS/ -w / } -Werror=return-type -Dmain="$symbol" -fsyntax-only "$source" 2> /dev/null; then
    # (raise-race forks in a signal handler, which the program has to be built to unwind at every import for; a program
    # of its own, it is the only one to carry that)
    if [ "$name" = raise-race ]; then export ECMAOS_WALI_ASYNCIFY_SIGNALS=all; fi
    "$WALI_CC" $CFLAGS "$source" "$WORK"/obj/common-*.o -o "$HERE/$test.wasm"
    unset ECMAOS_WALI_ASYNCIFY_SIGNALS
    continue
  fi
  "$WALI_CC" $CFLAGS -Dmain="$symbol" -c "$source" -o "$WORK/obj/$test.o"
  if grep -qE '^int main\(int' "$source"; then
    echo "int $symbol(int, char **);" >> "$WORK/tests.h"
    echo "static int run_$symbol(int argc, char **argv) { return $symbol(argc, argv); }" >> "$WORK/tests.h"
  else
    echo "int $symbol(void);" >> "$WORK/tests.h"
    echo "static int run_$symbol(int argc, char **argv) { (void)argc; (void)argv; return $symbol(); }" >> "$WORK/tests.h"
  fi
  table="$table	{ \"$test\", run_$symbol },\n"
done
printf 'static const struct test tests[] = {\n%b};\n' "$table" >> "$WORK/tests.h"

"$WALI_CC" -O2 -I"$WORK" -c "$HERE/runner.c" -o "$WORK/obj/runner.o"
"$WALI_CC" -O2 "$WORK"/obj/*.o -o "$HERE/libc-test.wasm" 2> "$WORK/link.log" || { cat "$WORK/link.log" >&2; exit 1; }
ls -l "$HERE"/*.wasm
echo "built with $WALI_TOOLCHAIN"
