#!/usr/bin/env bash
# Rebuilds programs/dash.wasm: the Debian Almquist shell, a POSIX sh, for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. dash forks for every command and pipeline, so the compiler rewrites it
# with Asyncify (utils/wali/asyncify.sh), which is why it needs Binaryen's wasm-opt. The result is committed, so only
# run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=0.5.12
SHA256=6a474ac46e8b0b32916c4c60df694c82058d3297d8b385b74508030ca4a8f28a
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o dash.tar.gz "http://gondor.apana.org.au/~herbert/dash/files/dash-$VERSION.tar.gz"
echo "$SHA256  dash.tar.gz" | sha256sum -c -
tar xzf dash.tar.gz
cd "dash-$VERSION"

# configure probes each function with a program that declares it as `char f()`, and wasm-ld checks signatures: the
# mismatch with musl's is a warning that configure's -Wl,--fatal-warnings makes an error, so every probe fails
# (and dash then defines its own killpg and strtod, which clash with musl's). The probes are not worth failing on.
sed -i 's/-Wl,--fatal-warnings//' configure
CC="$WALI_CC" AR=llvm-ar RANLIB=llvm-ranlib CFLAGS="-O2 -w" \
  ./configure --host=wasm32-linux-musl --enable-static > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp src/dash "$OUT/dash.wasm"
ls -l "$OUT/dash.wasm"
echo "built with $WALI_TOOLCHAIN"
