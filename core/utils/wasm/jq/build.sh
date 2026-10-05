#!/usr/bin/env bash
# Rebuilds programs/jq.wasm: jq for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
# Built like the other emcc programs (see ../vim/build.sh): `-sSTANDALONE_WASM=0` so the module imports the
# real `env.__syscall_*` calls that `core/kernel/src/bin/wasi-preview1.mjs` answers, and wasm exceptions for setjmp.
# Regular expressions come from the Oniguruma that ships inside the jq tarball.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

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

FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
emconfigure ./configure --disable-docs --disable-maintainer-mode --disable-shared --enable-static --disable-valgrind \
  --with-oniguruma=builtin --disable-error-injection CFLAGS="$FLAGS" > configure.log 2>&1
emmake make -C vendor/oniguruma -j"$(nproc)" CFLAGS="$FLAGS" > make-onig.log 2>&1 || { tail -30 make-onig.log >&2; exit 1; }
emmake make src/builtin.inc src/config_opts.inc > /dev/null 2>&1 || true   # generated headers, ahead of the parallel build
emmake make -j"$(nproc)" CFLAGS="$FLAGS" LDFLAGS="$FLAGS -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush" jq > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
WASM=$(find . -name 'jq.wasm' | head -1)
[ -n "$WASM" ] || { echo "no jq.wasm was produced" >&2; ls . .libs 2>/dev/null >&2; exit 1; }
cp "$WASM" "$OUT"
ls -l "$OUT"
