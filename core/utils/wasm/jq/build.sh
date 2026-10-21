#!/usr/bin/env bash
# Rebuilds programs/jq.wasm: jq for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali.
# The result is committed, so only run this to change it.
# Regular expressions come from the Oniguruma that ships inside the jq tarball.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=1.8.2
SHA256=71b8d6e8f5fe81f6c6d0d110e3892251f6ce76ed095abd315e26e6e1193af3af
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/jq.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o jq.tar.gz "https://github.com/jqlang/jq/releases/download/jq-$VERSION/jq-$VERSION.tar.gz"
echo "$SHA256  jq.tar.gz" | sha256sum -c -
tar xzf jq.tar.gz
cd "jq-$VERSION"

# Oniguruma types its hash data as `long` or `long long`, whichever is a pointer's size; on WALI a pointer is 4 bytes
# and both are 8, so neither was picked. `long long` becomes the fallback: it holds a pointer, which is all it is for.
for f in vendor/oniguruma/src/st.h vendor/oniguruma/src/regint.h; do
  grep -q '^#elif SIZEOF_VOIDP == SIZEOF_LONG_LONG$' "$f" || { echo "jq source changed: $f was not patched" >&2; exit 1; }
  sed -i 's/^#elif SIZEOF_VOIDP == SIZEOF_LONG_LONG$/#else/' "$f"
done

./configure --host=wasm32-linux-musl --disable-docs --disable-maintainer-mode --disable-shared --enable-static --disable-valgrind \
  --with-oniguruma=builtin --disable-error-injection CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS=-O2 \
  > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -C vendor/oniguruma -j"$(nproc)" > make-onig.log 2>&1 || { tail -30 make-onig.log >&2; exit 1; }
make src/builtin.inc src/config_opts.inc > /dev/null 2>&1 || true   # generated headers, ahead of the parallel build
make -j"$(nproc)" jq > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp jq "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
