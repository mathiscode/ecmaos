#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Makes a linked WALI program able to fork: Binaryen's Asyncify pass rewrites every function that can reach
# `wali.SYS_fork` so its frames can be saved (unwind) and rebuilt (rewind), which is how the host returns from the call
# in a parent and a child (bin/wali-host.mjs `drive`). wali-cc and wali-c++ run it on each program they link, after
# signal-checks.mjs; it rewrites the program in place, and leaves alone one that does not link fork (it has nothing to
# unwind, and pays nothing) or has been rewritten already.
#
# The cost falls on the programs that fork: dash grew by half and ran a pure-shell loop 39% slower. Say so in the build,
# so it is not a surprise. Two ways to change it:
#   ECMAOS_WALI_NO_ASYNCIFY=1     leave the program as it is: fork then fails with ENOSYS
#   ECMAOS_WALI_ASYNCIFY_ARGS     more Binaryen options for the pass, such as --pass-arg=asyncify-removelist@name,... to
#                                 keep the functions that cannot reach fork out of it (`asyncify-ignore-indirect` is
#                                 not one to add alone: a fork reached through a function pointer then traps)
#
# The features are named one by one: --all-features also turns on encodings the engines do not read.
# Usage: asyncify.sh <program.wasm>
set -euo pipefail
grep -aq SYS_fork "$1" || exit 0
grep -aq asyncify_start_unwind "$1" && exit 0
[ -z "${ECMAOS_WALI_NO_ASYNCIFY:-}" ] || exit 0
command -v wasm-opt > /dev/null || { echo "asyncify: $1 links fork, which needs wasm-opt (Binaryen, see utils/wali-version); ECMAOS_WALI_NO_ASYNCIFY=1 builds it without" >&2; exit 1; }
before=$(stat -c %s "$1")
# shellcheck disable=SC2086
wasm-opt "$1" --asyncify --pass-arg=asyncify-imports@wali.SYS_fork ${ECMAOS_WALI_ASYNCIFY_ARGS:-} -O2 \
  --enable-threads --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int \
  --enable-multivalue --enable-reference-types --enable-exception-handling -o "$1"
echo "wali: $(basename "$1") links fork, so Asyncify rewrote it ($before to $(stat -c %s "$1") bytes, and its functions that can reach fork run slower)" >&2
