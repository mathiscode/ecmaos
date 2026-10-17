#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/wlcomp.wasm: the Wayland compositor for ecmaOS (wlcomp.c, written for this project), with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
# Built like the other emcc programs (see ../vim/build.sh): `-sSTANDALONE_WASM=0` so the module imports the real
# `env.__syscall_*` calls that `core/kernel/src/bin/wasi-preview1.mjs` answers.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/wlcomp.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

emcc "$HERE/wlcomp.c" -O2 -Wall -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4194304 -o "$WORK/wlcomp.js"
cp "$WORK/wlcomp.wasm" "$OUT"
ls -l "$OUT"
