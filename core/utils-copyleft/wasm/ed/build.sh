#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/ed.wasm: GNU ed, the line editor, for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by
# /bin/wali. The result is committed, so only run this to change it. ed's own configure script only writes a Makefile,
# so the eight source files are compiled directly; the source is unmodified.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version ed)
ARCHIVE=$(node "$SOURCES" fetch ed)
OUT=$HERE/../../programs/ed.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "ed-$VERSION"

"$WALI_CC" -O2 -D_FILE_OFFSET_BITS=64 -DPROGVERSION="\"$VERSION\"" \
  buffer.c carg_parser.c global.c io.c main.c main_loop.c regex.c signal.c -o ed.wasm \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp ed.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
