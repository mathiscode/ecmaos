#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/lz4.wasm: the lz4 command-line tool (and unlz4, lz4cat, links to it) for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali.
#
# The result is committed, so only run this to change it. The command line tool is GPL-2.0-or-later (liblz4, linked
# in, is BSD-2-Clause), which is why this is in the copyleft package and not beside zstd. With threads
# (`LZ4IO_MULTITHREAD`, so `-T` compresses on that many workers); the source is unmodified.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version lz4)
ARCHIVE=$(node "$SOURCES" fetch lz4)
OUT=$HERE/../../programs/lz4.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "lz4-$VERSION"

"$WALI_CC" -O2 -DLZ4IO_MULTITHREAD=1 -Ilib -Iprograms \
  lib/lz4.c lib/lz4hc.c lib/lz4frame.c lib/xxhash.c programs/bench.c programs/lz4cli.c programs/lz4io.c programs/lorem.c \
  programs/threadpool.c programs/timefn.c programs/util.c -o lz4.wasm \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp lz4.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
