#!/usr/bin/env bash
# Rebuilds sdl-clip.wasm from sdl-clip.c: needs emcc, cmake, ninja, pkg-config, bison and the host wayland-scanner. Builds
# libwayland-client, libxkbcommon and SDL 3 first (../../../../../utils/wasm/lib/*.sh); SDL takes a few minutes.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../../../../../utils/wasm/lib/wayland.sh"
source "$HERE/../../../../../utils/wasm/lib/xkbcommon.sh"
source "$HERE/../../../../../utils/wasm/lib/sdl.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
build_wayland "$WORK"
build_xkbcommon "$WORK"
build_sdl "$WORK"
emcc "$HERE/sdl-clip.c" $SDL_INC -O2 -Wall -fwasm-exceptions -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4194304 \
  $SDL_LIB $SDL_DEPS_LIB -o "$WORK/sdl-clip.js"
cp "$WORK/sdl-clip.wasm" "$HERE/sdl-clip.wasm"
ls -l "$HERE/sdl-clip.wasm"
