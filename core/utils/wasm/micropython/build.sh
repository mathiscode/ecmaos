#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/micropython.wasm: MicroPython (the Unix port: script runner and REPL) for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. Built from the release tarball with three small changes, each
# asserted below so a new release that moves the code fails the build instead of silently losing the change:
#   - an uncaught exception prints its traceback on stderr (upstream's Unix port prints it on stdout);
#   - the default heap is 16 MiB (upstream's is 1 MiB), and -X heapsize still sets it;
#   - the C stack is 512 KiB and the interpreter's recursion limit follows it.
#
# The garbage collector is the part that needs care. MicroPython's collector is conservative: it scans the C stack and
# the machine registers for anything that looks like a pointer. WebAssembly has no registers to scan; a value the
# compiler keeps in a wasm local is invisible to it, so an object held only that way is freed while still in use (the
# first build of this program failed a `str.join` over a generator exactly like that). Binaryen's `--spill-pointers`
# pass (`wasm-opt`, which this build needs) writes every such value to the C stack across calls, which is what the
# collector scans; it runs on the linked program, and then the names it found the stack pointer by are stripped. The stress test
# (`tests/tree/wasi/micropython.test.ts`) runs the same workload on heaps from 256 KiB up and compares with CPython.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"
command -v wasm-opt > /dev/null || { echo "micropython: wasm-opt (binaryen) not found; its --spill-pointers pass is what keeps the collector right" >&2; exit 1; }

VERSION=1.29.0
SHA256=d925a7c664e79a2bdf3dfcb285ba5e2237041cc35a0bd4ee573b6c5711efeca0
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/micropython.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Replace one exact line, and fail if it is not there exactly once.
patch_line() { # file old new
  local count
  count=$(grep -cF -- "$2" "$1" || true)
  [ "$count" = 1 ] || { echo "micropython: expected exactly one '$2' in $1, found $count" >&2; exit 1; }
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1:4]
text = open(path).read()
open(path, 'w').write(text.replace(old, new, 1))
PY
}

cd "$WORK"
curl -fsSL -o micropython.tar.xz "https://github.com/micropython/micropython/releases/download/v$VERSION/micropython-$VERSION.tar.xz"
echo "$SHA256  micropython.tar.xz" | sha256sum -c -
tar xf micropython.tar.xz
cd "micropython-$VERSION"

patch_line shared/runtime/pyexec.c 'mp_obj_print_exception(&mp_plat_print, MP_OBJ_FROM_PTR(nlr.ret_val));' \
  'mp_obj_print_exception(MICROPY_ERROR_PRINTER, MP_OBJ_FROM_PTR(nlr.ret_val));'
patch_line ports/unix/main.c 'long heap_size = 1024 * 1024 * (sizeof(mp_uint_t) / 4);' \
  'long heap_size = 16 * 1024 * 1024;'
patch_line ports/unix/main.c 'mp_uint_t stack_size = 40000 * UNIX_STACK_MULTIPLIER;' \
  'mp_uint_t stack_size = 480 * 1024;'

cd ports/unix
# Freezing compiles the modules with mpy-cross, which has to run here, so it is built with the host compiler.
make -C ../../mpy-cross -j"$(nproc)" > mpy-cross.log 2>&1 || { tail -30 mpy-cross.log >&2; exit 1; }

# No threads (the collector stops the other threads with a real-time signal from pthread_kill, which WALI programs
# have now, but threads are not tried here yet), ffi (no dlopen), sockets, tls, btree or filesystems of its own. The
# frozen modules are in manifest.py.
make -j"$(nproc)" BUILD=build CC="$WALI_CC" STRIP=true SIZE=true FROZEN_MANIFEST="$HERE/manifest.py" \
  MICROPY_PY_BTREE=0 MICROPY_PY_THREAD=0 MICROPY_PY_FFI=0 MICROPY_PY_SSL=0 MICROPY_PY_SOCKET=0 \
  MICROPY_VFS_FAT=0 MICROPY_VFS_LFS1=0 MICROPY_VFS_LFS2=0 MICROPY_PY_TERMIOS=1 \
  LDFLAGS_ARCH="-Wl,--gc-sections" CFLAGS_EXTRA="-DMICROPY_USE_INTERNAL_PRINTF=0" \
  > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
wasm-opt build/micropython --spill-pointers --strip-debug -o "$OUT" > wasm-opt.log 2>&1 || { tail -30 wasm-opt.log >&2; exit 1; }
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN and wasm-opt $(wasm-opt --version | grep -oE 'version [0-9]+' | cut -d" " -f2)"
