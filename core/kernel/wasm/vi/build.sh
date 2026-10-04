#!/usr/bin/env bash
# Rebuilds src/bin/wasm/vi.wasm: busybox's `vi` for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6) and a host gcc. The result is committed, so only run this to change it.
#
# What differs from a stock build, and why:
#  - `-sSTANDALONE_WASM=0`: an output named `.wasm` makes emscripten 6 standalone, which compiles
#    `ioctl` and `poll` to stubs. The ordinary build imports the real `env.__syscall_*` calls, which
#    `src/bin/wasi-preview1.mjs` answers against the tty.
#  - `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm`: setjmp/longjmp as wasm exceptions, so the module
#    does not import `invoke_*` helpers from emscripten's JS glue (the host has none).
#  - vi-posix-regex.patch: busybox's `/` and `:s` use GNU `re_search`, which musl does not have.
#  - the link is done by hand: busybox's own final link passes GNU ld flags wasm-ld rejects.
set -euo pipefail

VERSION=1.37.0
SHA256=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../src/bin/wasm/vi.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o bb.tar.bz2 "https://busybox.net/downloads/busybox-$VERSION.tar.bz2"
echo "$SHA256  bb.tar.bz2" | sha256sum -c -
tar xjf bb.tar.bz2
cd "busybox-$VERSION"
patch -p1 < "$HERE/vi-posix-regex.patch"
cp "$HERE/busybox.config" .config
make oldconfig < <(yes "") > /dev/null
sed -i 's/-Wl,--warn-common//' Makefile.flags scripts/trylink
make -j"$(nproc)" CC=emcc HOSTCC=gcc AR=emar STRIP=true SKIP_STRIP=y \
  CONFIG_EXTRA_CFLAGS="-sSUPPORT_LONGJMP=wasm -fwasm-exceptions" busybox_unstripped > build.log 2>&1 || true

# busybox's own link fails; its log still lists every object it meant to link.
read -r -a objects <<< "$(grep -o 'applets/built-in.o.*util-linux/volume_id/built-in.o' busybox_unstripped.out | head -1)"
emcc "${objects[@]}" -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sSTANDALONE_WASM=0 \
  -sEXPORTED_FUNCTIONS=_main,_fflush -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -o "$WORK/vi.js"
cp "$WORK/vi.wasm" "$OUT"
ls -l "$OUT"
