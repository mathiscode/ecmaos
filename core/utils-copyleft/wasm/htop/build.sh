#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/htop.wasm: htop 3.5.3, the interactive process viewer, for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. It reads /proc as on Linux (stat, meminfo, <pid>/stat, status, cmdline)
# and draws with ncurses, which is built here as screen's is: a static wide-character library with the xterm,
# xterm-256color, vt100 and linux descriptions compiled in (there is no terminfo database to read). The result is
# committed, so only run this to change it. Needs the host's `tic` and `infocmp`.
#
# What is changed in htop's source, asserted so a new release that moves the code fails the build:
#   - main() starts by setting TERM: it is `xterm.js`, a name none of those descriptions have, so htop is given
#     xterm-256color for it.
# Configured without sched_setaffinity, hwloc, libcap, delay accounting and libsensors: the browser has one scheduler
# and no such devices.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
HTOP=$(node "$SOURCES" version htop htop)
NCURSES=$(node "$SOURCES" version htop ncurses)
HTOP_ARCHIVE=$(node "$SOURCES" fetch htop htop)
NCURSES_ARCHIVE=$(node "$SOURCES" fetch htop ncurses)
OUT=$HERE/../../programs/htop.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$NCURSES_ARCHIVE"
tar xJf "$HTOP_ARCHIVE"

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

cd "$WORK/htop-$HTOP"
python3 - <<'PY'
p = 'htop.c'
s = open(p).read()
old = "int main(int argc, char** argv) {\n"
assert s.count(old) == 1, "htop source changed: main() not found"
s = '#include <stdlib.h>\n#include <string.h>\n' + s
s = s.replace(old, old + '   if (!getenv("TERM") || !strcmp(getenv("TERM"), "xterm.js"))\n      setenv("TERM", "xterm-256color", 1);\n', 1)
open(p, 'w').write(s)
PY
INC="-I$WORK/prefix/include -I$WORK/prefix/include/ncursesw"
CC="$WALI_CC" CFLAGS="-O2 $INC" CPPFLAGS="$INC" LDFLAGS="-L$WORK/prefix/lib" \
  HTOP_NCURSESW_CONFIG_SCRIPT=/bin/false ac_cv_lib_ncursesw_addnwstr=yes \
  ./configure --host=wasm32-unknown-linux-musl --disable-affinity --disable-hwloc \
    --disable-capabilities --disable-delayacct --disable-sensors --disable-werror > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { grep -E -B3 -A6 'error|undefined' make.log | head -40 >&2; exit 1; }
cp htop "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
