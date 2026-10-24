#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/screen.wasm: GNU screen 5.0.1 for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali.
# It is the terminal multiplexer, and the serial console of a board: `screen /dev/ttyACM0 115200`.
#
# Needs the host's `tic` and `infocmp` (ncurses builds its fallback terminal descriptions with them) and Binaryen's
# wasm-opt: screen forks (its server detaches from the terminal it was started on, and each window's shell is a fork
# and an exec), so the program is linked with Asyncify (utils/wali/asyncify.sh) and pays for it in size. The result is
# committed, so only run this to change it. screen draws with termcap, from ncurses, which is built here as nano's is:
# a static wide-character library with the xterm, xterm-256color, vt100 and linux descriptions compiled in (there is
# no terminfo database to read).
#
# What is changed in screen's source, asserted so a new release that moves the code fails the build:
#   - main() starts by setting TERM and SHELL: TERM is `xterm.js`, a name none of those descriptions have, so screen
#     is given xterm-256color for it; SHELL, which each window runs, is the kernel's own shell (`ecmaos`) unless the
#     login shell is a program, and it has no file to run, so screen is given /bin/sh then.
# Configured without the socket directory (`/run/screen`) so sockets are made in ~/.screen, without PAM and utmp.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
SCREEN=$(node "$SOURCES" version screen screen)
NCURSES=$(node "$SOURCES" version screen ncurses)
SCREEN_ARCHIVE=$(node "$SOURCES" fetch screen screen)
NCURSES_ARCHIVE=$(node "$SOURCES" fetch screen ncurses)
OUT=$HERE/../../programs/screen.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$NCURSES_ARCHIVE"
tar xzf "$SCREEN_ARCHIVE"

mkdir prefix
cd "ncurses-$NCURSES"
CC="$WALI_CC" CFLAGS=-O2 AR="$WALI_AR" RANLIB="$WALI_RANLIB" ./configure --host=wasm32-unknown-linux-musl \
  --prefix="$WORK/prefix" --without-ada --without-cxx --without-cxx-binding --without-manpages --without-progs \
  --without-tests --without-shared --without-debug --disable-database --with-fallbacks=xterm-256color,xterm,vt100,linux \
  --with-tic-path="$(command -v tic)" --with-infocmp-path="$(command -v infocmp)" --without-gpm \
  --disable-stripping --enable-widec --disable-home-terminfo > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
# the build-time helpers (make_keys writes the key table: without it curses recognises no arrow or function key) are
# run here, so they are built with the host compiler
sed -i 's/^BUILD_CC\t= .*/BUILD_CC\t= cc/; s/^BUILD_CCFLAGS\t= .*/BUILD_CCFLAGS\t=/; s/^BUILD_LDFLAGS\t= .*/BUILD_LDFLAGS\t=/; s/^BUILD_LIBS\t= .*/BUILD_LIBS\t=/' ncurses/Makefile
make -j"$(nproc)" libs > make.log 2>&1 || true # the last step builds a host-side helper that does not run; the library is what we want
grep -q "KEY_A1" ncurses/init_keytry.h || { echo "ncurses: init_keytry.h is empty (the host helper make_keys did not run), so arrow keys would not work" >&2; exit 1; }
[ -f lib/libncursesw.a ] || { tail -30 make.log >&2; exit 1; }
make install.includes > /dev/null 2>&1
mkdir -p "$WORK/prefix/lib" && cp lib/libncursesw.a "$WORK/prefix/lib/"

cd "$WORK/screen-$SCREEN"
python3 - <<'PY'
p = 'screen.c'
s = open(p).read()
old = "int main(int argc, char **argv)\n{\n"
assert s.count(old) == 1, "screen source changed: main() not found"
s = s.replace(old, old + '\tif (!getenv("TERM") || !strcmp(getenv("TERM"), "xterm.js")) setenv("TERM", "xterm-256color", 1);\n'
              + '\tif (getenv("SHELL") && *getenv("SHELL") != \'/\') setenv("SHELL", "/bin/sh", 1);\n', 1)
open(p, 'w').write(s)
PY
INC="-I$WORK/prefix/include -I$WORK/prefix/include/ncursesw"
CC="$WALI_CC" CFLAGS="-O2 $INC" LDFLAGS="-L$WORK/prefix/lib" LIBS="-lncursesw" \
  ./configure --host=wasm32-unknown-linux-musl --disable-pam --disable-socket-dir --enable-colors256 > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp screen "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
