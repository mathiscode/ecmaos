#!/usr/bin/env bash
# Rebuilds wl-lib.wasm from wl-lib.c on WALI's musl (`utils/check-wali.sh`): needs the host wayland-scanner, bison, cmake,
# ninja and pkg-config. Builds libwayland-client and libxkbcommon first (../../../../../utils/wasm/lib/*.sh).
set -euo pipefail
source "$(dirname "$0")/../../../../../../utils/check-wali.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../../../../../utils/wasm/lib/wayland.sh"
source "$HERE/../../../../../utils/wasm/lib/xkbcommon.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
build_wayland "$WORK" wali
build_xkbcommon "$WORK" wali
wayland_protocol "$WORK" xdg-shell /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
"$WALI_CC" "$HERE/wl-lib.c" "$WORK/protocols/xdg-shell-protocol.c" -I"$WORK/protocols" $WAYLAND_INC $XKBCOMMON_INC -O2 -Wall \
  $WAYLAND_LIB $XKBCOMMON_LIB -o "$WORK/wl-lib.wasm"
cp "$WORK/wl-lib.wasm" "$HERE/wl-lib.wasm"
ls -l "$HERE/wl-lib.wasm"
