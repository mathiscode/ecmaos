#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of programs that need TLS (CPython's ssl and hashlib): builds OpenSSL 3.5 (an LTS release,
# Apache-2.0) as static libraries on WALI's musl (the caller has sourced utils/check-wali.sh) into "$1/prefix", with its
# headers, and sets OPENSSL_INC and OPENSSL_LIB for the caller. No assembly, no shared libraries (there is no
# dlopen), pthread locks (Python refuses a build without OPENSSL_THREADS), no engines or loadable providers, and no secure heap (mlock and guard pages do not exist here).
set -euo pipefail

OPENSSL=3.5.9
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

build_openssl() {
  local work=$1
  ( cd "$work"
    curl -fsSL -o openssl.tar.gz "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL/openssl-$OPENSSL.tar.gz"
    echo "$OPENSSL_SHA256  openssl.tar.gz" | sha256sum -c -
    tar xzf openssl.tar.gz
    mkdir -p prefix
    cd "openssl-$OPENSSL"
    CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" ./Configure linux-generic32 --prefix="$work/prefix" --openssldir=/etc/ssl --libdir=lib \
      no-asm threads no-shared no-dso no-engine no-module no-secure-memory no-afalgeng no-ui-console no-tests no-apps \
      no-docs no-legacy -O2 -w > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
    make -j"$(nproc)" build_libs > make.log 2>&1 || { grep -a "error" make.log | head -20 >&2; exit 1; }
    make install_dev > install.log 2>&1 || { tail -30 install.log >&2; exit 1; } )
  OPENSSL_INC="-I$work/prefix/include"
  OPENSSL_LIB="-L$work/prefix/lib"
}
