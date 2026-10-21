#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/ncdu.wasm: ncdu 1.x (the C version, MIT), the disk usage browser, for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`) with ncurses (see ../lib/ncurses.sh), run by /bin/wali. The source is unmodified except for
# the environment main() starts with: TERM, as ncdu starts curses without looking at it, and this terminal is
# `xterm.js`, which has no terminfo entry, so it is given xterm-256color; and SHELL, which `b` runs (with system(), so
# posix_spawn), is the kernel's own shell (`ecmaos`) unless the login shell is a program; it has no file to run, so
# ncdu is given /bin/sh then.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=1.22
SHA256=0ad6c096dc04d5120581104760c01b8f4e97d4191d6c9ef79654fa3c691a176b
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/ncdu.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
source "$HERE/../lib/ncurses.sh"

cd "$WORK"
curl -fsSL -o ncdu.tar.gz "https://dev.yorhel.nl/download/ncdu-$VERSION.tar.gz"
echo "$SHA256  ncdu.tar.gz" | sha256sum -c -
tar xzf ncdu.tar.gz
build_ncurses "$WORK" wali

cd "ncdu-$VERSION"
python3 - <<'PY'
p = 'src/main.c'
s = open(p).read()
old = "int main(int argc, char **argv) {\n"
assert old in s, "ncdu source changed: main() not found"
s = s.replace(old, old + '  if (!getenv("TERM") || !strcmp(getenv("TERM"), "xterm.js")) setenv("TERM", "xterm-256color", 1);\n'
              + '  if (getenv("SHELL") && *getenv("SHELL") != \'/\') setenv("SHELL", "/bin/sh", 1);\n', 1)
open(p, 'w').write(s)
PY
CC="$WALI_CC" CFLAGS="-O2 $NCURSES_INC" LDFLAGS="$NCURSES_LIB" \
  NCURSES_CFLAGS="$NCURSES_INC" NCURSES_LIBS="-lncursesw" \
  ./configure --host=wasm32-linux-musl --with-ncursesw > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp ncdu "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
