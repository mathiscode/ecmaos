#!/usr/bin/env bash
# Rebuilds wl-lib.wasm from wl-lib.c: needs emcc and the host wayland-scanner. Builds libwayland-client first (../../../../../utils/wasm/lib/wayland.sh).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../../../../../utils/wasm/lib/wayland.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
build_wayland "$WORK"
wayland_protocol "$WORK" xdg-shell /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
emcc "$HERE/wl-lib.c" "$WORK/protocols/xdg-shell-protocol.c" -I"$WORK/protocols" $WAYLAND_INC -O2 -Wall -fwasm-exceptions \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4194304 $WAYLAND_LIB -o "$WORK/wl-lib.js"
cp "$WORK/wl-lib.wasm" "$HERE/wl-lib.wasm"
ls -l "$HERE/wl-lib.wasm"
