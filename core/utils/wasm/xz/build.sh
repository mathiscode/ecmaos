#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/xz.wasm: xz (and unxz, xzcat, lzma, unlzma, lzcat: links to it) for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. With threads (`-T`, each a worker), no shell scripts (xzdiff and friends
# are GPL), no liblzma shared library. The source is unmodified; the command line tool and liblzma are 0BSD.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=5.8.4
SHA256=0014c7886930454fe8bd4228665b51af55eeae560ea135c9c4cd33f55b2591d9
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/xz.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o xz.tar.gz "https://github.com/tukaani-project/xz/releases/download/v$VERSION/xz-$VERSION.tar.gz"
echo "$SHA256  xz.tar.gz" | sha256sum -c -
tar xzf xz.tar.gz
cd "xz-$VERSION"

./configure --host=wasm32-linux-musl --disable-shared --enable-static --enable-threads=posix --disable-nls \
  --disable-scripts --disable-doc --disable-xzdec --disable-lzmadec --disable-lzmainfo --disable-symbol-versions \
  CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS=-O2 > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" -C src/liblzma > make-lib.log 2>&1 || { tail -30 make-lib.log >&2; exit 1; }
make -j"$(nproc)" -C src/xz xz > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp src/xz/xz "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
