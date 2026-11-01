#!/usr/bin/env bash
# Rebuilds wl-shm.wasm from wl-shm.c on WALI's musl (`utils/check-wali.sh`). It speaks the Wayland wire protocol itself,
# so it links no library.
set -euo pipefail
source "$(dirname "$0")/../../../../../../utils/check-wali.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
"$WALI_CC" "$HERE/wl-shm.c" -O2 -Wall -o "$HERE/wl-shm.wasm"
ls -l "$HERE/wl-shm.wasm"
