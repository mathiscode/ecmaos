#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/patch.wasm: `patch` from toybox (0BSD), for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by
# /bin/wali. The GNU patch is GPL; this is the permissive one. Toybox builds one command on its own with
# scripts/single.sh; it targets Linux, which WALI's musl is, so it builds as it is. One source change: toybox calls
# its exit handlers through `void (*)(int)` but declares `tempfile_handler(void)`, which a native ABI tolerates and
# WebAssembly traps on, so it is given the parameter.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=0.8.12
SHA256=ad88a921133ae2231d9f2df875ec0bd42af4429145caea7d7db9e02208a6fd2e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/patch.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o toybox.tar.gz "https://landley.net/toybox/downloads/toybox-$VERSION.tar.gz"
echo "$SHA256  toybox.tar.gz" | sha256sum -c -
tar xzf toybox.tar.gz
cd "toybox-$VERSION"

grep -q '^static void tempfile_handler(void)$' lib/lib.c || { echo "toybox source changed: tempfile_handler not found" >&2; exit 1; }
sed -i 's/^static void tempfile_handler(void)$/static void tempfile_handler(int sig)/' lib/lib.c

CC=$WALI_CC HOSTCC=cc NOSTRIP=1 CFLAGS="-O2" LDOPTIMIZE="-Wl,--gc-sections" \
  scripts/single.sh patch > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
cp generated/unstripped/patch "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
