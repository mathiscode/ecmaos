#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/nano.wasm: GNU nano 9.2 for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6) and the host's `tic` and `infocmp` (ncurses builds its fallback terminal descriptions
# with them). The result is committed, so only run this to change it. Built like the other emcc programs (see
# ../vim/build.sh). nano draws with ncurses, which is built here too, as a static wide-character library with the
# xterm, xterm-256color, vt100 and linux descriptions compiled in (there is no terminfo database to read).
# `TERM` is `xterm.js`, a name none of those have, so the build makes nano fall back to xterm-256color for it.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
NANO=$(node "$SOURCES" version nano nano)
NCURSES=$(node "$SOURCES" version nano ncurses)
NANO_ARCHIVE=$(node "$SOURCES" fetch nano nano)
NCURSES_ARCHIVE=$(node "$SOURCES" fetch nano ncurses)
OUT=$HERE/../../programs/nano.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$NCURSES_ARCHIVE"
tar xJf "$NANO_ARCHIVE"

mkdir prefix
cd "ncurses-$NCURSES"
CC=emcc CFLAGS="-O2 -fwasm-exceptions" ./configure --host=wasm32-unknown-emscripten --prefix="$WORK/prefix" \
  --without-ada --without-cxx --without-cxx-binding --without-manpages --without-progs --without-tests \
  --without-shared --without-debug --disable-database --with-fallbacks=xterm-256color,xterm,vt100,linux \
  --with-tic-path="$(command -v tic)" --with-infocmp-path="$(command -v infocmp)" --without-gpm \
  --disable-stripping --enable-widec --disable-home-terminfo > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" libs > make.log 2>&1 || true # the last step builds a host-side helper that does not run; the library is what we want
[ -f lib/libncursesw.a ] || { tail -30 make.log >&2; exit 1; }
make install.includes > /dev/null 2>&1
mkdir -p "$WORK/prefix/lib" && cp lib/libncursesw.a "$WORK/prefix/lib/"

cd "$WORK/nano-$NANO"
# nano starts curses without looking at TERM first; give the name this terminal has an entry that is there.
sed -i '/^int main(int argc, char \*\*argv)/{n;s/{/{\n\tconst char *term = getenv("TERM");\n\n\tif (term == NULL || strcmp(term, "xterm.js") == 0)\n\t\tsetenv("TERM", "xterm-256color", 1);\n/}' src/nano.c
grep -q 'xterm-256color' src/nano.c || { echo "nano source changed: the TERM fallback was not patched in" >&2; exit 1; }
INC="-I$WORK/prefix/include -I$WORK/prefix/include/ncursesw"
CC=emcc CFLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm $INC" \
  LDFLAGS="-L$WORK/prefix/lib -fwasm-exceptions -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush" \
  NCURSESW_CFLAGS="$INC" NCURSESW_LIBS="-lncursesw" \
  ./configure --host=wasm32-unknown-emscripten --sysconfdir=/etc --disable-nls --enable-utf8 --disable-speller \
  --disable-browser --disable-libmagic > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp src/nano.wasm "$OUT"
ls -l "$OUT"
