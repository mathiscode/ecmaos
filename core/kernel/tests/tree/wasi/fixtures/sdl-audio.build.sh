#!/usr/bin/env bash
# Rebuilds sdl-audio.wasm from sdl-audio.c on WALI's musl (`utils/check-wali.sh`), linked with SDL 3 the way the SDL demos are: needs
# cmake, ninja, pkg-config, bison and the host wayland-scanner. Builds libwayland-client, libxkbcommon and SDL 3 first
# (../../../../../utils/wasm/lib/*.sh); SDL takes a few minutes.
set -euo pipefail
source "$(dirname "$0")/../../../../../../utils/check-wali.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../../../../../utils/wasm/lib/wayland.sh"
source "$HERE/../../../../../utils/wasm/lib/xkbcommon.sh"
source "$HERE/../../../../../utils/wasm/lib/sdl.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
build_wayland "$WORK" wali
build_xkbcommon "$WORK" wali
build_sdl "$WORK" wali
"$WALI_CC" "$HERE/sdl-audio.c" $SDL_INC -O2 -Wall $SDL_LIB $SDL_DEPS_LIB -o "$WORK/sdl-audio.wasm"
cp "$WORK/sdl-audio.wasm" "$HERE/sdl-audio.wasm"
ls -l "$HERE/sdl-audio.wasm"
