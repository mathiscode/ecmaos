#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/wldemo.wasm: a demo Wayland client for ecmaOS (wldemo.c, written for this project), linked with
# libwayland-client and libxkbcommon (see ../lib/wayland.sh and ../lib/xkbcommon.sh) and the xdg-shell protocol code.
#
# Built on WALI's musl (`utils/check-wali.sh`), with the libraries built the same way, and run by /bin/wali.
# Needs the host `wayland-scanner` and `bison`. The result is committed, so only run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/wayland.sh"
source "$HERE/../lib/xkbcommon.sh"
OUT=$HERE/../../programs/wldemo.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

build_wayland "$WORK" wali
build_xkbcommon "$WORK" wali
wayland_protocol "$WORK" xdg-shell /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
"$WALI_CC" "$HERE/wldemo.c" "$WORK/protocols/xdg-shell-protocol.c" -I"$WORK/protocols" $WAYLAND_INC $XKBCOMMON_INC -O2 -Wall \
  $WAYLAND_LIB $XKBCOMMON_LIB -o "$WORK/wldemo.wasm"
cp "$WORK/wldemo.wasm" "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
