#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/sdlgl.wasm: an OpenGL ES window for ecmaOS (sdlgl.c, written for this project), linked with SDL 3 on its
# Wayland driver (see ../lib/sdl.sh, ../lib/wayland.sh and ../lib/xkbcommon.sh).
#
# Needs `emcc` (emscripten 6), cmake, ninja, pkg-config, bison and the host `wayland-scanner`; SDL takes a few
# minutes to build. The result is committed, so only run this to change it. Built like the other emcc programs (see
# ../wlcomp/build.sh).
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/wayland.sh"
source "$HERE/../lib/xkbcommon.sh"
source "$HERE/../lib/sdl.sh"
OUT=$HERE/../../programs/sdlgl.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

build_wayland "$WORK"
build_xkbcommon "$WORK"
build_sdl "$WORK"
emcc "$HERE/sdlgl.c" $SDL_INC -O2 -Wall -fwasm-exceptions -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4194304 \
  $SDL_LIB $SDL_DEPS_LIB -o "$WORK/sdlgl.js"
cp "$WORK/sdlgl.wasm" "$OUT"
ls -l "$OUT"
