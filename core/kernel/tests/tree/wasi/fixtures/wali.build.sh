#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds the WALI fixtures (wali-*.wasm) from their sources with the pinned WALI toolchain (utils/check-wali.sh,
# which builds the sysroot the first time). Run from anywhere.
set -euo pipefail
source "$(dirname "$0")/../../../../../../utils/check-wali.sh"
cd "$(dirname "$0")"
for source in wali-*.c; do "$WALI_CC" -O2 "$source" -o "${source%.c}.wasm"; done
for source in wali-*.cpp; do "$WALI_CXX" -O2 "$source" -o "${source%.cpp}.wasm"; done
ls -l wali-*.wasm
echo "built with $WALI_TOOLCHAIN"
