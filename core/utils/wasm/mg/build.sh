#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/mg.wasm: mg, the small Emacs-style editor from OpenBSD (portable version: public domain with
# ISC/BSD-licensed files), for ecmaOS, with emscripten and ncurses (see ../lib/ncurses.sh). Built like the other emcc
# programs (see ../../../utils-copyleft/wasm/vim/build.sh), straight from the file list in the source's GNUmakefile.
# The source is unmodified except for TERM: mg starts curses without looking at it, and this terminal is `xterm.js`,
# which has no terminfo entry, so it is given xterm-256color. `compat/` has what musl lacks that mg expects from libbsd:
# the BSD <sys/queue.h> and strtonum().
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"

VERSION=20260719
SHA256=8ca736b1e57d9681e7921d37b9cf0282e3098e2929ed37384400c78dae54762d
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/mg.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
source "$HERE/../lib/ncurses.sh"

cd "$WORK"
curl -fsSL -o mg.tar.gz "https://github.com/hboetes/mg/archive/refs/tags/$VERSION.tar.gz"
echo "$SHA256  mg.tar.gz" | sha256sum -c -
tar xzf mg.tar.gz
build_ncurses "$WORK"

cd "mg-$VERSION"
python3 - <<'PY'
import re
p = 'main.c'
s = open(p).read()
m = re.search(r'\nmain\(int argc, char \*\*argv\)\n\{\n', s)
assert m, "mg source changed: main() not found"
s = s[:m.end()] + '\tif (!getenv("TERM") || !strcmp(getenv("TERM"), "xterm.js"))\n\t\tsetenv("TERM", "xterm-256color", 1);\n' + s[m.end():]
open(p, 'w').write(s)
PY
SOURCES=$(sed -n '/^OBJS=/,/^OBJS+=/p' GNUmakefile | tr -d '\\' | grep -oE '[a-z_]+\.o' | sed 's/\.o$/.c/' | tr '\n' ' ')
emcc -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -DREGEX -D_GNU_SOURCE -Wno-deprecated-declarations -include "$HERE/compat/bsd.h" -I"$HERE/compat" $NCURSES_INC \
  $SOURCES recallocarray.c "$HERE/compat/bsd.c" -o mg.js $NCURSES_LIB -lncursesw \
  -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp mg.wasm "$OUT"
ls -l "$OUT"
