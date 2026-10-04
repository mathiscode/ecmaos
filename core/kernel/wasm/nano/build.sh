#!/usr/bin/env bash
# Rebuilds src/bin/wasm/nano.wasm: GNU nano 9.2 for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6) and the host's `tic` and `infocmp` (ncurses builds its fallback terminal descriptions
# with them). The result is committed, so only run this to change it. Built like the other emcc programs (see
# ../vim/build.sh). nano draws with ncurses, which is built here too, as a static wide-character library with the
# xterm, xterm-256color, vt100 and linux descriptions compiled in (there is no terminfo database to read).
# `TERM` is `xterm.js`, a name none of those have, so the build makes nano fall back to xterm-256color for it.
set -euo pipefail

NANO=9.2
NANO_SHA256=05ecb99247b782e8a5b3a25ed4101dd034b0236902f7449bc9795b717642f7e9
NCURSES=6.5
NCURSES_SHA256=136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../src/bin/wasm/nano.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o ncurses.tar.gz "https://ftp.gnu.org/gnu/ncurses/ncurses-$NCURSES.tar.gz"
echo "$NCURSES_SHA256  ncurses.tar.gz" | sha256sum -c -
curl -fsSL -o nano.tar.xz "https://www.nano-editor.org/dist/v${NANO%%.*}/nano-$NANO.tar.xz"
echo "$NANO_SHA256  nano.tar.xz" | sha256sum -c -
tar xzf ncurses.tar.gz
tar xJf nano.tar.xz

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
