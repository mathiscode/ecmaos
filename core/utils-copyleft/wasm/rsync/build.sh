#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/rsync.wasm: rsync 3.5.1 for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali.
# It copies trees locally and talks to any other rsync over ssh (`rsync -a dir host:dir` runs `ssh host rsync --server`),
# as the rsync of a Linux machine does. rsync forks (the receiver splits into a generator and a receiver, and a remote
# shell is a fork and an exec), so wali-cc links it with Asyncify. The result is committed, so only run this to change it.
#
# Built with the bundled zlib and popt, and without what has no library here or no use: OpenSSL, xxhash, zstd and LZ4
# (MD5 and MD4 checksums and zlib compression remain, which every rsync speaks), IDN, iconv, ACLs and xattrs.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version rsync)
ARCHIVE=$(node "$SOURCES" fetch rsync)
OUT=$HERE/../../programs/rsync.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
cd "rsync-$VERSION"
CC="$WALI_CC" CFLAGS=-O2 ./configure --host=wasm32-unknown-linux-musl --disable-md2man --disable-openssl --disable-xxhash \
  --disable-zstd --disable-lz4 --disable-idn --disable-iconv --disable-acl-support --disable-xattr-support \
  --with-included-popt --with-included-zlib > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" rsync > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp rsync "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
