#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/tmux.wasm: tmux 3.5a for ecmaOS, on WALI's musl (`utils/check-wali.sh`) with libevent 2.1.12 and
# ncurses (see ../lib/ncurses.sh), run by /bin/wali. tmux forks: the first client makes the server (a fork that
# detaches), and the server makes a pty and a child for each pane, so the compiler rewrites it with Asyncify
# (utils/wali/asyncify.sh), which is why it needs Binaryen's wasm-opt. The result is committed, so only run this to
# change it.
# The source is unmodified but for its start: a TERM of `xterm.js` (the terminal's own name, which ncurses has no entry
# for) or none becomes xterm-256color, as for mg.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=3.5a
SHA256=16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951
LIBEVENT=2.1.12-stable
LIBEVENT_SHA256=92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/tmux.wasm
WORK=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT
source "$HERE/../lib/ncurses.sh"

cd "$WORK"
build_ncurses "$WORK" wali

curl -fsSL -o libevent.tar.gz "https://github.com/libevent/libevent/releases/download/release-$LIBEVENT/libevent-$LIBEVENT.tar.gz"
echo "$LIBEVENT_SHA256  libevent.tar.gz" | sha256sum -c -
tar xzf libevent.tar.gz
( cd "libevent-$LIBEVENT"
  CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS="-O2 -w" ./configure --host=wasm32-linux-musl --prefix="$WORK/prefix" \
    --disable-shared --disable-openssl --disable-samples --disable-libevent-regress --disable-debug-mode > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
  make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
  make install > /dev/null 2>&1 )

curl -fsSL -o tmux.tar.gz "https://github.com/tmux/tmux/releases/download/$VERSION/tmux-$VERSION.tar.gz"
echo "$SHA256  tmux.tar.gz" | sha256sum -c -
tar xzf tmux.tar.gz
cd "tmux-$VERSION"
python3 - <<'PY'
s = open('tmux.c').read()
old = '\tsetlocale(LC_TIME, "");\n'
assert old in s, "tmux source changed: no setlocale(LC_TIME) in main()"
s = s.replace(old, '\tif (getenv("TERM") == NULL || strcmp(getenv("TERM"), "xterm.js") == 0)\n\t\tsetenv("TERM", "xterm-256color", 1);\n' + old, 1)
open('tmux.c', 'w').write(s)
PY
CC="$WALI_CC" CFLAGS="-O2 -w $NCURSES_INC" LDFLAGS="-L$WORK/prefix/lib" PKG_CONFIG_PATH="$WORK/prefix/lib/pkgconfig" \
  LIBEVENT_CFLAGS="-I$WORK/prefix/include" LIBEVENT_LIBS="-L$WORK/prefix/lib -levent" \
  LIBNCURSES_CFLAGS="$NCURSES_INC" LIBNCURSES_LIBS="-L$WORK/prefix/lib -lncursesw" \
  ./configure --host=wasm32-linux-musl --enable-static > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
grep -a "^wali:" make.log >&2 || true
cp tmux "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
