#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Makes a linked WALI program able to fork: Binaryen's Asyncify pass rewrites every function that can reach
# `wali.SYS_fork` so its frames can be saved (unwind) and rebuilt (rewind), which is how the host returns from the call
# in a parent and a child (bin/wali-host.mjs `drive`). Rewrites the program in place. Run it after linking, on a
# program that calls fork; it grows the program and slows the functions that can reach fork.
#
# The features are named one by one: --all-features also turns on encodings the engines do not read.
# Usage: asyncify.sh <program.wasm>
set -euo pipefail
command -v wasm-opt > /dev/null || { echo "asyncify: wasm-opt (binaryen) not found" >&2; exit 1; }
wasm-opt "$1" --asyncify --pass-arg=asyncify-imports@wali.SYS_fork -O2 \
  --enable-threads --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int \
  --enable-multivalue --enable-reference-types --enable-exception-handling -o "$1"
