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
#   ECMAOS_WALI_ASYNCIFY_INDIRECT the functions (comma separated) whose calls through a pointer can reach fork, such as
#                                 dash's evalbltin, which runs a builtin. Asyncify then rewrites only the functions that
#                                 can reach fork by direct calls and these (asyncify-reach.mjs), where it would take every
#                                 call through a pointer for one that does: dash grows by 12% where it grows by half, and
#                                 its shell loop is 10% slower where it is 65%. It needs the program's function names, which
#                                 wasm-ld leaves out of a program linked with -O2 (link without it), and a function it
#                                 misses is one whose fork traps in the child
#   ECMAOS_WALI_ASYNCIFY_SIGNALS  the wali imports (comma separated, such as SYS_tgkill,__ecmaos_poll, or `all`) at which a
#                                 signal handler may fork. The host runs a handler where an import returns, so a fork in one
#                                 unwinds through that import too, and the program has to save its frames there: every
#                                 function that calls one of them is rewritten (a signal that arrives where the program was
#                                 not built to unwind makes the handler's fork fail with ENOSYS). The imports are kept in
#                                 the program's ecmaos.asyncify-signals section. A program that forks only outside its
#                                 handlers leaves this alone; one that forks in a handler it raises itself (`raise`,
#                                 `kill`) needs the kill calls, and one that forks in a handler a timer or another thread
#                                 sets off needs __ecmaos_poll and every call it blocks in
#
# The features are named one by one: --all-features also turns on encodings the engines do not read.
# Usage: asyncify.sh <program.wasm>
set -euo pipefail
grep -aq SYS_fork "$1" || exit 0
grep -aq asyncify_start_unwind "$1" && exit 0
[ -z "${ECMAOS_WALI_NO_ASYNCIFY:-}" ] || exit 0
command -v wasm-opt > /dev/null || { echo "asyncify: $1 links fork, which needs wasm-opt (Binaryen, see utils/wali-version); ECMAOS_WALI_NO_ASYNCIFY=1 builds it without" >&2; exit 1; }
before=$(stat -c %s "$1")
only=
strip=
imports=wali.SYS_fork
signals=${ECMAOS_WALI_ASYNCIFY_SIGNALS:-}
reach="$(dirname "$0")/asyncify-reach.mjs"
if [ "$signals" = all ]; then signals=$(node "$reach" --imports "$1"); fi
if [ -n "$signals" ]; then imports="$imports,wali.${signals//,/,wali.}"; fi
if [ -n "${ECMAOS_WALI_ASYNCIFY_INDIRECT:-}" ]; then
  only=--pass-arg=asyncify-onlylist@$(node "$reach" "$1" "$ECMAOS_WALI_ASYNCIFY_INDIRECT" "$signals")
  # the names were only for the list
  strip=--strip-debug
fi
# shellcheck disable=SC2086
wasm-opt "$1" --asyncify --pass-arg=asyncify-imports@"$imports" $only ${ECMAOS_WALI_ASYNCIFY_ARGS:-} -O2 $strip \
  --enable-threads --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int \
  --enable-multivalue --enable-reference-types --enable-exception-handling -o "$1"
if [ -n "$signals" ]; then node "$reach" --mark "$1" "$signals"; fi
echo "wali: $(basename "$1") links fork, so Asyncify rewrote it ($before to $(stat -c %s "$1") bytes, and its functions that can reach fork run slower)" >&2
