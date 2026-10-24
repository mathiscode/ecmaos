#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/v4l2grab.wasm: takes a picture from a /dev/video camera (v4l2grab.c, written for this project).
#
# Built on WALI's musl (`utils/check-wali.sh`) and run by /bin/wali. The result is committed, so only run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/v4l2grab.wasm
"$WALI_CC" "$HERE/v4l2grab.c" -O2 -Wall -o "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
