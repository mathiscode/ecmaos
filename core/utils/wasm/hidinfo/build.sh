#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/hidinfo.wasm: lists the HID devices of /dev/hidraw* (hidinfo.c, written for this project).
#
# Built on WALI's musl (`utils/check-wali.sh`) and run by /bin/wali. The result is committed, so only run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/hidinfo.wasm
"$WALI_CC" "$HERE/hidinfo.c" -O2 -Wall -o "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
