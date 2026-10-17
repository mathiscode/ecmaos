#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/wldemo.wasm: a demo Wayland client for ecmaOS (wldemo.c, written for this project), linked with
# libwayland-client and libxkbcommon (see ../lib/wayland.sh and ../lib/xkbcommon.sh) and the xdg-shell protocol code.
#
# Needs `emcc` (emscripten 6), the host `wayland-scanner` and `bison`. The result is committed, so only run this to
# change it. Built like the other emcc programs (see ../wlcomp/build.sh).
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/wayland.sh"
source "$HERE/../lib/xkbcommon.sh"
OUT=$HERE/../../programs/wldemo.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

build_wayland "$WORK"
build_xkbcommon "$WORK"
wayland_protocol "$WORK" xdg-shell /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
emcc "$HERE/wldemo.c" "$WORK/protocols/xdg-shell-protocol.c" -I"$WORK/protocols" $WAYLAND_INC $XKBCOMMON_INC -O2 -Wall -fwasm-exceptions \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4194304 $WAYLAND_LIB $XKBCOMMON_LIB -o "$WORK/wldemo.js"
cp "$WORK/wldemo.wasm" "$OUT"
ls -l "$OUT"
