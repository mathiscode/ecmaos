#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/lolcat.wasm: jaseg's lolcat 1.5 (WTFPL), the C lolcat, which paints its input in a rainbow (256
# colours, 16 with -x, 24-bit with -b), for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali. The
# source is unmodified; its colour table (xterm256lut.h) comes with it, so no Python is needed. censor is not built.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=1.5
SHA256=2af79bed90e0bda52ae500d16e7e7022037fad10c487c317e7f0ff17ec4b14f5
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/lolcat.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o lolcat.tar.gz "https://github.com/jaseg/lolcat/archive/refs/tags/v$VERSION.tar.gz"
echo "$SHA256  lolcat.tar.gz" | sha256sum -c -
tar xzf lolcat.tar.gz
cd "lolcat-$VERSION"
"$WALI_CC" -std=c11 -O2 -o lolcat lolcat.c -lm
cp lolcat "$OUT"
mkdir -p "$HERE/../../licenses/lolcat" && cp LICENSE "$HERE/../../licenses/lolcat/LICENSE"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
