#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/sl.wasm: sl 5.02, the steam locomotive for those who mistype ls (Toyoda Masashi's license: anything
# may be done with it but claiming to have written it), for ecmaOS, on WALI's musl (`utils/check-wali.sh`) with
# ncurses (see ../lib/ncurses.sh), run by /bin/wali. The source is unmodified except for the environment main() starts
# with: TERM, as sl starts curses without looking at it, and this terminal is `xterm.js`, which has no terminfo entry,
# so it is given xterm-256color. As on Linux, ^C does not stop the train.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=5.02
SHA256=1e5996757f879c81f202a18ad8e982195cf51c41727d3fea4af01fdcbbb5563a
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/sl.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
source "$HERE/../lib/ncurses.sh"

cd "$WORK"
curl -fsSL -o sl.tar.gz "https://github.com/mtoyoda/sl/archive/refs/tags/$VERSION.tar.gz"
echo "$SHA256  sl.tar.gz" | sha256sum -c -
tar xzf sl.tar.gz
build_ncurses "$WORK" wali

cd "sl-$VERSION"
python3 - <<'PY'
p = 'sl.c'
s = open(p).read()
old = "int main(int argc, char *argv[])\n{\n"
assert s.count(old) == 1, "sl source changed: main() not found"
s = s.replace(old, old + '    if (!getenv("TERM") || !strcmp(getenv("TERM"), "xterm.js")) setenv("TERM", "xterm-256color", 1);\n', 1)
open(p, 'w').write(s)
PY
"$WALI_CC" -O2 $NCURSES_INC -include stdlib.h -include string.h -o sl sl.c $NCURSES_LIB -lncursesw
cp sl "$OUT"
mkdir -p "$HERE/../../licenses/sl" && cp LICENSE "$HERE/../../licenses/sl/LICENSE"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
