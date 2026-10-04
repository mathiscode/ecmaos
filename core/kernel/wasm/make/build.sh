#!/usr/bin/env bash
# Rebuilds src/bin/wasm/make.wasm: GNU make 4.4.1 for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it. Built like the other emcc
# programs (see ../vim/build.sh). There is no fork, so `ecmaos-spawn.c` (linked in, and called from a patched
# `child_execute_job`) runs each recipe line to completion through system(); make therefore runs one job at a time.
set -euo pipefail

VERSION=4.4.1
SHA256=dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../src/bin/wasm/make.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o make.tar.gz "https://ftp.gnu.org/gnu/make/make-$VERSION.tar.gz"
echo "$SHA256  make.tar.gz" | sha256sum -c -
tar xzf make.tar.gz
cd "make-$VERSION"

# The vfork branch of child_execute_job becomes a synchronous run; the rest of that branch is then unreachable.
python3 - <<'PY'
p = 'src/job.c'
s = open(p).read()
old = "    pid = vfork ();\n    if (pid != 0)"
assert old in s, "make source changed: vfork call not found"
s = s.replace(old, "    extern pid_t ecmaos_run (char **, int);\n    pid = ecmaos_run (argv, fdout);\n    if (1)")
s = s.replace("pid_t\nchild_execute_job (struct childbase *child, int good_stdin, char **argv)\n{", "pid_t\nchild_execute_job (struct childbase *child, int good_stdin, char **argv)\n{", 1)
open(p, 'w').write(s)
PY
cp "$HERE/ecmaos-spawn.c" src/ecmaos-spawn.c

FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
LINK="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sEXPORTED_FUNCTIONS=_main,_fflush"
CC=emcc CFLAGS="$FLAGS" LDFLAGS="$LINK" ./configure --host=wasm32-unknown-emscripten --without-guile --disable-nls \
  --disable-load --disable-posix-spawn --disable-dependency-tracking > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
emcc $FLAGS -c src/ecmaos-spawn.c -o src/ecmaos-spawn.o
make -j"$(nproc)" LIBS="$PWD/src/ecmaos-spawn.o" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp make.wasm "$OUT"
ls -l "$OUT"
