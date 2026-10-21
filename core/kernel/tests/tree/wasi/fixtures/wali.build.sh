#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds the WALI fixtures (wali-*.wasm) from their sources with the pinned WALI toolchain (utils/check-wali.sh,
# which builds the sysroot the first time), and the WALI builds of the fixtures both C libraries run with the same
# assertions (emcc-<name>.c, built here as wali-<name>.wasm). Run from anywhere.
set -euo pipefail
source "$(dirname "$0")/../../../../../../utils/check-wali.sh"
cd "$(dirname "$0")"
for source in wali-*.c; do "$WALI_CC" -O2 "$source" -o "${source%.c}.wasm"; done
for source in wali-*.cpp; do "$WALI_CXX" -O2 "$source" -o "${source%.cpp}.wasm"; done
for source in emcc-mmap.c emcc-proc.c; do name=${source#emcc-}; "$WALI_CC" -O2 "$source" -o "wali-${name%.c}.wasm"; done
ls -l wali-*.wasm
echo "built with $WALI_TOOLCHAIN"
