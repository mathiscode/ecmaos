#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/cmatrix.wasm: cmatrix 2.0, the falling characters of The Matrix, for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. It draws with ncurses, which is built here as htop's is: a static
# wide-character library with the xterm, xterm-256color, vt100 and linux descriptions compiled in (there is no terminfo
# database to read). The result is committed, so only run this to change it. Needs the host's `tic` and `infocmp`.
#
# Built without autotools or CMake: one file, with the defines CMake gives it, and none for the Linux console's fonts
# (setfont and consolechars, which a browser terminal has not got) or TIOCSTI (which -s uses to hand the key that ends
# the screensaver to the shell; Linux has turned it off by default too).
# What is changed in cmatrix's source, asserted so a new release that moves the code fails the build:
#   - main() starts by setting TERM: it is `xterm.js`, a name none of those descriptions have, so cmatrix is given
#     xterm-256color for it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
CMATRIX=$(node "$SOURCES" version cmatrix cmatrix)
NCURSES=$(node "$SOURCES" version cmatrix ncurses)
CMATRIX_ARCHIVE=$(node "$SOURCES" fetch cmatrix cmatrix)
NCURSES_ARCHIVE=$(node "$SOURCES" fetch cmatrix ncurses)
OUT=$HERE/../../programs/cmatrix.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$NCURSES_ARCHIVE"
tar xzf "$CMATRIX_ARCHIVE"

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

cd "$WORK/cmatrix-$CMATRIX"
python3 - <<'PY'
p = 'cmatrix.c'
s = open(p).read()
old = "int main(int argc, char *argv[]) {\n"
assert s.count(old) == 1, "cmatrix source changed: main() not found"
s = s.replace(old, old + '    if (!getenv("TERM") || !strcmp(getenv("TERM"), "xterm.js"))\n        setenv("TERM", "xterm-256color", 1);\n', 1)
open(p, 'w').write(s)
PY
"$WALI_CC" -O2 -I"$WORK/prefix/include" -I"$WORK/prefix/include/ncursesw" -DEXCLUDE_CONFIG_H -DVERSION="\"$CMATRIX\"" \
  -DHAVE_NCURSES_H -DHAVE_SYS_IOCTL_H -DHAVE_UNISTD_H -DHAVE_TERMIOS_H -DHAVE_RESIZETERM -DHAVE_WRESIZE \
  -DHAVE_USE_DEFAULT_COLORS -o cmatrix cmatrix.c -L"$WORK/prefix/lib" -lncursesw
cp cmatrix "$OUT"
mkdir -p "$HERE/../../licenses/cmatrix" && cp COPYING "$HERE/../../licenses/cmatrix/COPYING"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
