#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of programs that use zlib (CPython, and anything later that wants it): builds zlib 1.3.2
# (the zlib license) as a static library on WALI's musl (the caller has sourced utils/check-wali.sh) into "$1/prefix",
# with its header, and sets ZLIB_INC and ZLIB_LIB for the caller.
set -euo pipefail

ZLIB=1.3.2
ZLIB_SHA256=bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16

build_zlib() {
  local work=$1
  ( cd "$work"
    curl -fsSL -o zlib.tar.gz "https://github.com/madler/zlib/releases/download/v$ZLIB/zlib-$ZLIB.tar.gz"
    echo "$ZLIB_SHA256  zlib.tar.gz" | sha256sum -c -
    tar xzf zlib.tar.gz
    mkdir -p prefix
    cd "zlib-$ZLIB"
    CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS="-O2 -w" ./configure --static --prefix="$work/prefix" > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
    make -j"$(nproc)" libz.a > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
    make install > /dev/null 2>&1 )
  ZLIB_INC="-I$work/prefix/include"
  ZLIB_LIB="-L$work/prefix/lib"
}
