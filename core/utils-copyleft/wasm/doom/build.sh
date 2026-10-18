#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/doom.wasm: id Software's Doom for ecmaOS. The engine is doomgeneric (GPL-2.0, a portable
# cut of the Doom source release; https://github.com/ozkl/doomgeneric) and the platform layer is doomecma.c, which
# draws into a window on SDL 3 on its Wayland driver, with doomsound.c as the engine's sound module. SDL, libwayland
# and libxkbcommon are built by the shared scripts of @ecmaos/coreutils (core/utils/wasm/lib/sdl.sh, wayland.sh and
# xkbcommon.sh in the repository; wasm/lib/ in that npm package), from the archives pinned here in programs/manifest.json.
# The engine is software rendered; no game data is included (see the doom manual page for where to get a WAD).
#
# Needs `emcc` (emscripten 6), cmake, ninja, pkg-config, bison and the host `wayland-scanner`; SDL takes a few
# minutes to build. The result is committed, so only run this to change it. Built like the other emcc programs (see
# core/utils/wasm/wlcomp/build.sh). No music: the engine's music module does nothing.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
LIB=$HERE/../../../utils/wasm/lib
COMMIT=$(node "$SOURCES" version doom doomgeneric)
DOOMGENERIC_ARCHIVE=$(node "$SOURCES" fetch doom doomgeneric)
SDL_ARCHIVE=$(node "$SOURCES" fetch doom sdl)
WAYLAND_ARCHIVE=$(node "$SOURCES" fetch doom wayland)
XKBCOMMON_ARCHIVE=$(node "$SOURCES" fetch doom xkbcommon)
source "$LIB/wayland.sh"
source "$LIB/xkbcommon.sh"
source "$LIB/sdl.sh"
[ "$SDL" = "$(node "$SOURCES" version doom sdl)" ] && [ "$WAYLAND" = "$(node "$SOURCES" version doom wayland)" ] &&
  [ "$XKBCOMMON" = "$(node "$SOURCES" version doom xkbcommon)" ] ||
  { echo "doom: the SDL, libwayland or libxkbcommon version in $LIB differs from programs/manifest.json" >&2; exit 1; }
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

[ -d "$WORK/doomgeneric-$COMMIT" ] || ( cd "$WORK" && tar xzf "$DOOMGENERIC_ARCHIVE" )
SRC=$WORK/doomgeneric-$COMMIT/doomgeneric
# every engine file but the other platforms' layers and the sound and music modules (SDL_mixer and Allegro)
ENGINE_SOURCES=$(cd "$SRC" && ls *.c | grep -v -e '^doomgeneric_' -e '^i_allegro' -e '^i_sdlmusic\.c$' -e '^i_sdlsound\.c$' -e '^icon\.c$' | sed "s|^|$SRC/|")
# i_sound.c includes SDL_mixer.h when sound is on; doomsound.c is the sound module instead, so the header is empty
mkdir -p "$WORK/stub" && : > "$WORK/stub/SDL_mixer.h"
emcc $ENGINE_SOURCES "$HERE/doomecma.c" "$HERE/doomsound.c" -I"$SRC" -I"$WORK/stub" -DFEATURE_SOUND $SDL_INC -O2 -w -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 ${DOOM_EXTRA:-} \
  $SDL_LIB $SDL_DEPS_LIB -o "$WORK/doom.js"
cp "$WORK/doom.wasm" "$OUT"
ls -l "$OUT"
