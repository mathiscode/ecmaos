#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/sdlsnake.wasm: Snake for ecmaOS (sdlsnake.c, written for this project), linked with SDL 3 on its
# Wayland driver (see ../lib/sdl.sh, ../lib/wayland.sh and ../lib/xkbcommon.sh).
#
# Built on WALI's musl (`utils/check-wali.sh`), with the libraries built the same way, and run by /bin/wali. Needs
# cmake, ninja, pkg-config, bison and the host `wayland-scanner`; SDL takes a few minutes to build. The result is
# committed, so only run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/wayland.sh"
source "$HERE/../lib/xkbcommon.sh"
source "$HERE/../lib/sdl.sh"
OUT=$HERE/../../programs/sdlsnake.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

build_wayland "$WORK" wali
build_xkbcommon "$WORK" wali
build_sdl "$WORK" wali
"$WALI_CC" "$HERE/sdlsnake.c" $SDL_INC -O2 -Wall $SDL_LIB $SDL_DEPS_LIB -o "$WORK/sdlsnake.wasm"
cp "$WORK/sdlsnake.wasm" "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
