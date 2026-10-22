#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/mandoc.wasm: mandoc, the man(7) and mdoc(7) formatter, for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. The result is committed, so only run this to change it.
# mandoc has its own configure script, driven here by a configure.local. Built without the man page database (apropos,
# makewhatis) and the CGI program: only the formatter, with its terminal, HTML, Markdown and lint output. The one
# library is zlib, built here too, so a gzipped page can be read. The source is unmodified. (mandoc pipes a page into a
# pager only when it is run as `man`, which is not installed: this system's `man` is its own.)
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=1.14.6
SHA256=8bf0d570f01e70a6e124884088870cbed7537f36328d512909eb10cd53179d9c
ZLIB=1.3.1
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/mandoc.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o zlib.tar.gz "https://zlib.net/fossils/zlib-$ZLIB.tar.gz"
echo "$ZLIB_SHA256  zlib.tar.gz" | sha256sum -c -
tar xzf zlib.tar.gz
( cd "zlib-$ZLIB"
  CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS=-O2 ./configure --static --prefix="$WORK/prefix" > configure.log 2>&1 \
    || { tail -30 configure.log >&2; exit 1; }
  make -j"$(nproc)" install > make.log 2>&1 || { tail -30 make.log >&2; exit 1; } )

curl -fsSL -o mandoc.tar.gz "https://mandoc.bsd.lv/snapshots/mandoc-$VERSION.tar.gz"
echo "$SHA256  mandoc.tar.gz" | sha256sum -c -
tar xzf mandoc.tar.gz
cd "mandoc-$VERSION"

# configure runs each test program it builds, which this machine cannot do for WALI: a test that compiles and links
# passes, as in any cross build, and the one that tests behaviour, which regex word boundary syntax works, is set below
grep -q '^	if ./test-${1} 1>&3 2>&3; then$' configure || { echo "mandoc's configure changed: its test run was not found" >&2; exit 1; }
sed -i 's/^	if .\/test-${1} 1>&3 2>&3; then$/	if true; then/' configure
cat > configure.local <<CONF
CC="$WALI_CC"
AR="$WALI_AR"
CFLAGS="-O2 -I$WORK/prefix/include"
LDFLAGS="-L$WORK/prefix/lib"
PREFIX=/usr
MANDIR=/usr/share/man
BUILD_DB=0
BUILD_CGI=0
HAVE_MANPATH=0
HAVE_LESS_T=0
HAVE_REWB_BSD=0
HAVE_REWB_SYSV=1
CONF
./configure > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" mandoc > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp mandoc "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
