#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/zstd.wasm: zstd (and unzstd, zstdcat: links to it) for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. With threads (`ZSTD_MULTITHREAD`, so `-T` compresses on that many
# workers), no zlib/lzma/lz4 file formats. The source is unmodified; zstd is dual-licensed BSD-3-Clause or GPL-2.0, and
# this uses it under BSD-3-Clause.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=1.5.7
SHA256=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/zstd.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o zstd.tar.gz "https://github.com/facebook/zstd/releases/download/v$VERSION/zstd-$VERSION.tar.gz"
echo "$SHA256  zstd.tar.gz" | sha256sum -c -
tar xzf zstd.tar.gz
cd "zstd-$VERSION"

SOURCES="$(ls lib/common/*.c lib/compress/*.c lib/decompress/*.c lib/dictBuilder/*.c lib/legacy/*.c) $(ls programs/*.c)"
"$WALI_CC" -O2 -DZSTD_MULTITHREAD -DZSTD_LEGACY_SUPPORT=5 -DZSTD_DISABLE_ASM=1 \
  -Ilib -Ilib/common -Ilib/legacy -Iprograms $SOURCES -o zstd.wasm \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp zstd.wasm "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
