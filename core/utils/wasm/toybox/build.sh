#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/patch.wasm: `patch` from toybox (0BSD), for ecmaOS, with emscripten. The GNU patch is GPL; this
# is the permissive one. Toybox builds one command on its own with scripts/single.sh; it targets Linux and glibc,
# so `compat/` supplies what emscripten's libc lacks (inotify, xattr, swap and personality headers whose calls just
# fail, and a `syscall()` that returns ENOSYS), force-included into every file. One source change: toybox calls its exit handlers through `void (*)(int)`
# but declares `tempfile_handler(void)`, which a native ABI tolerates and WebAssembly traps on, so it is given the parameter.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

VERSION=0.8.12
SHA256=ad88a921133ae2231d9f2df875ec0bd42af4429145caea7d7db9e02208a6fd2e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/patch.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o toybox.tar.gz "https://landley.net/toybox/downloads/toybox-$VERSION.tar.gz"
echo "$SHA256  toybox.tar.gz" | sha256sum -c -
tar xzf toybox.tar.gz
cd "toybox-$VERSION"

grep -q '^static void tempfile_handler(void)$' lib/lib.c || { echo "toybox source changed: tempfile_handler not found" >&2; exit 1; }
sed -i 's/^static void tempfile_handler(void)$/static void tempfile_handler(int sig)/' lib/lib.c

FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
CC=emcc HOSTCC=cc NOSTRIP=1 \
  CFLAGS="$FLAGS -D__linux__=1 -D_GNU_SOURCE -include $HERE/compat/compat.h -I$HERE/compat" \
  LDFLAGS="$FLAGS -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush" \
  LDOPTIMIZE="-Wl,--gc-sections" \
  scripts/single.sh patch > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp generated/unstripped/patch.wasm "$OUT"
ls -l "$OUT"
