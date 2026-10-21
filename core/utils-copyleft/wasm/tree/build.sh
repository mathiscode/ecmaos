#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/tree.wasm: `tree`, the directory listing, for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run
# by /bin/wali. The result is committed, so only run this to change it.
#
# One source change: tree prints its counts (size_t and ssize_t) with %ld, which is the same width on Linux; on WALI
# `long` is 8 bytes and size_t 4, so printf read past them (the summary said "36030373271961603 director"). They are
# printed with %zd, except the inode numbers, which tree casts to long.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version tree)
ARCHIVE=$(node "$SOURCES" fetch tree)
OUT=$HERE/../../programs/tree.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "tree-$VERSION"

sed -i '/(long int)ent->inode/!s/%ld/%zd/g' *.c
[ "$(grep -o '%zd' *.c | wc -l)" = 17 ] || { echo "tree source changed: the %ld counts were not patched" >&2; exit 1; }

"$WALI_CC" -O2 -DLINUX -D_LARGEFILE64_SOURCE -D_FILE_OFFSET_BITS=64 tree.c list.c hash.c color.c file.c filter.c info.c unix.c xml.c json.c html.c strverscmp.c -o tree.wasm \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp tree.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
