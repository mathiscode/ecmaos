#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/evtest.wasm: `evtest`, which lists the input devices and prints what one of them reports, for
# ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali. The result is committed, so only run this to change it.
#
# No source changes: the program is one file, compiled without its configure script (it only names the version).
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version evtest)
ARCHIVE=$(node "$SOURCES" fetch evtest)
OUT=$HERE/../../programs/evtest.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "evtest-evtest-$VERSION"

"$WALI_CC" -O2 -DPACKAGE_VERSION="\"$VERSION\"" evtest.c -o evtest.wasm > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp evtest.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
