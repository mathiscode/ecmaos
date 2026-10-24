#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/python3.wasm and programs/python3-lib.tar.gz: CPython 3.14 for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. os.fork, subprocess and multiprocessing's fork start method work, so the
# compiler rewrites the program with Asyncify (utils/wali/asyncify.sh), which is why it needs Binaryen's wasm-opt; the
# interpreter runs about half as fast for it. The result is committed, so only run this to change it.
#
# - A cross build runs a Python of the same version on the build machine, which this builds from the same tarball.
# - Extension modules are linked into the program (there is no dlopen). zlib (../lib/zlib.sh) is in, which gzip, zipfile
#   and tarfile's compressed modes need. bz2, lzma, zstd, ssl, ctypes, curses, readline, sqlite3 and dbm are left out:
#   configure would find the build machine's libraries for some of them, so their headers are told to be absent.
# - patch-multiprocessing.py: WALI's `long` is 64 bits and its pointers 32, and a semaphore shared by processes cannot
#   be a word in shared memory (see that file).
# - The standard library is a tarball rooted at /, unpacked to /usr/lib/python3.14 (the program's prefix is /usr), with
#   the tests, the GUI, the installers and the build-time config left out, and the rest compiled ahead of time.
#   The compiled files are checked by their source's hash, not its modification time, which a tar does not keep.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"
source "$(dirname "$0")/../lib/zlib.sh"

VERSION=3.14.9
SHA256=e02d9ac21cebda6e46435369744a92c65cc7cd8669697694122cf97ffacd1e53
MINOR=${VERSION%.*}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/python3.wasm
LIB=$HERE/../../programs/python3-lib.tar.gz
WORK=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT

cd "$WORK"
build_zlib "$WORK"
curl -fsSL -o python.tar.xz "https://www.python.org/ftp/python/$VERSION/Python-$VERSION.tar.xz"
echo "$SHA256  python.tar.xz" | sha256sum -c -
tar xJf python.tar.xz
SRC=$WORK/Python-$VERSION
python3 "$HERE/patch-multiprocessing.py" "$SRC/Modules/_multiprocessing"

mkdir host
( cd host
  "$SRC/configure" -q > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
  make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; } )

cat > config.site <<'EOF'
ac_cv_file__dev_ptmx=yes
ac_cv_file__dev_ptc=no
ac_cv_buggy_getaddrinfo=no
ac_cv_header_bzlib_h=no
ac_cv_header_lzma_h=no
ac_cv_header_zstd_h=no
EOF

mkdir wali
cd wali
export PKG_CONFIG_LIBDIR=/nonexistent PKG_CONFIG_PATH=
CONFIG_SITE=$WORK/config.site CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS="-O2 -w" CPPFLAGS="$ZLIB_INC" LDFLAGS="$ZLIB_LIB" \
  "$SRC/configure" --build="$("$SRC/config.guess")" --host=wasm32-linux-musl --with-build-python="$WORK/host/python" \
  --prefix=/usr --disable-ipv6 --without-ensurepip --disable-test-modules > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { grep -a "error" make.log | head -20 >&2; exit 1; }
grep -a "^wali: python " make.log >&2 || true
make install DESTDIR="$WORK/image" > install.log 2>&1 || { tail -30 install.log >&2; exit 1; }

LIBDIR=$WORK/image/usr/lib/python$MINOR
( cd "$LIBDIR"
  rm -rf config-$MINOR idlelib pydoc_data ensurepip tkinter turtle.py turtledemo test idle_test
  find . -name __pycache__ -prune -exec rm -rf {} + )
"$WORK/host/python" -m compileall -q --invalidation-mode unchecked-hash "$LIBDIR" > /dev/null
tar -C "$WORK/image" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - "usr/lib/python$MINOR" | gzip -9n > "$LIB"

cp python "$OUT"
ls -l "$OUT" "$LIB"
echo "built with $WALI_TOOLCHAIN"
