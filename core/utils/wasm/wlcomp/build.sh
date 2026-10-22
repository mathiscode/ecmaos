#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/wlcomp.wasm: the Wayland compositor for ecmaOS (wlcomp.c, written for this project).
#
# Built on WALI's musl (`utils/check-wali.sh`) and run by /bin/wali. Needs `xxd`. The result is committed, so only run
# this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/wlcomp.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

( cd "$HERE" && xxd -i keymap-us.xkb ) > "$WORK/keymap-us.h"
"$WALI_CC" "$HERE/wlcomp.c" -I"$WORK" -O2 -Wall -o "$WORK/wlcomp.wasm"
cp "$WORK/wlcomp.wasm" "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
