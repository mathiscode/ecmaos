#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/doom.wasm: id Software's Doom for ecmaOS. The engine is doomgeneric (GPL-2.0, a portable
# cut of the Doom source release; https://github.com/ozkl/doomgeneric) and the platform layer is doomecma.c, which
# draws into a window on SDL 3 on its Wayland driver (see ../lib/sdl.sh, ../lib/wayland.sh and ../lib/xkbcommon.sh).
# The engine is software rendered; no game data is included (see doom.md for where to get a WAD).
#
# Needs `emcc` (emscripten 6), cmake, ninja, pkg-config, bison and the host `wayland-scanner`; SDL takes a few
# minutes to build. The result is committed, so only run this to change it. Built like the other emcc programs (see
# ../wlcomp/build.sh). No sound yet: the engine's sound module wants SDL_mixer, so it is left out.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

COMMIT=e257a09527062bfb986b6e5e0780839b6cbd5b71
SHA256=26f8f60daa6c6e4d3c01e5eac9fb700d592dede803d13ac848154ff356b2a2e7
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/wayland.sh"
source "$HERE/../lib/xkbcommon.sh"
source "$HERE/../lib/sdl.sh"
OUT=$HERE/../../programs/doom.wasm
if [ -n "${DOOM_WORK:-}" ]; then WORK=$DOOM_WORK; mkdir -p "$WORK"; else WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT; fi   # DOOM_WORK keeps the SDL build between runs

if [ -f "$WORK/prefix/lib/libSDL3.a" ] && [ -n "${DOOM_WORK:-}" ]; then
  SDL_INC="-I$WORK/prefix/include"; SDL_LIB="-L$WORK/prefix/lib -lSDL3"
  SDL_DEPS_LIB="-L$WORK/prefix/lib -lwayland-cursor -lwayland-egl -lwayland-client -lxkbcommon"
else
  build_wayland "$WORK"
  build_xkbcommon "$WORK"
  build_sdl "$WORK"
fi

[ -d "$WORK/doomgeneric-$COMMIT" ] || ( cd "$WORK"
  curl -fsSL -o doomgeneric.tar.gz "https://github.com/ozkl/doomgeneric/archive/$COMMIT.tar.gz"
  echo "$SHA256  doomgeneric.tar.gz" | sha256sum -c -
  tar xzf doomgeneric.tar.gz )
SRC=$WORK/doomgeneric-$COMMIT/doomgeneric
# every engine file but the other platforms' layers and the sound and music modules (SDL_mixer and Allegro)
SOURCES=$(cd "$SRC" && ls *.c | grep -v -e '^doomgeneric_' -e '^i_allegro' -e '^i_sdlmusic\.c$' -e '^i_sdlsound\.c$' -e '^icon\.c$' | sed "s|^|$SRC/|")
emcc $SOURCES "$HERE/doomecma.c" -I"$SRC" $SDL_INC -O2 -w -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 ${DOOM_EXTRA:-} \
  $SDL_LIB $SDL_DEPS_LIB -o "$WORK/doom.js"
cp "$WORK/doom.wasm" "$OUT"
ls -l "$OUT"
