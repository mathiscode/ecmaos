#!/usr/bin/env bash
# Rebuilds programs/bc.wasm (which is dc too): Gavin Howard's `bc` and `dc` (POSIX bc with GNU extras), for ecmaOS,
# on WALI's musl (`utils/check-wali.sh`), run by /bin/wali.
#
# Needs a host C compiler too (the build generates its math library with a host-side tool). The result is committed,
# so only run this to change it. History and line editing are bc's own (`--enable-internal-history`), on the raw terminal.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=7.0.3
SHA256=6e59d1154d167f8073a56de58a5476cc6213a7672abdf4197b5cc9599d56cd43
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o bc.tar.gz "https://github.com/gavinhoward/bc/releases/download/$VERSION/bc-$VERSION.tar.gz"
echo "$SHA256  bc.tar.gz" | sha256sum -c -
tar xzf bc.tar.gz
cd "bc-$VERSION"

# bc only enters its interactive mode (prompt, history, line editing) when stdin, stdout and stderr are all
# terminals. Here a foreground command's stderr is a stream the kernel pumps to the terminal, not a tty, so ask
# about stdin and stdout only (what Vim and the SQLite shell do too).
sed -i 's/tty = (ttyin != 0 \&\& ttyout != 0 \&\& ttyerr != 0);/tty = (ttyin != 0 \&\& ttyout != 0); (void) ttyerr;/' src/vm.c
grep -q '(void) ttyerr' src/vm.c || { echo "bc source changed: the tty check was not patched" >&2; exit 1; }

HOSTCC=${HOSTCC:-cc} CC="$WALI_CC" HOSTCFLAGS="-O1" CFLAGS="-O2" \
  ./configure.sh --enable-internal-history --disable-nls --disable-man-pages --disable-strip > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
# bc and dc are one program that picks its personality from argv[0]; ecmaOS links /bin/dc to it.
cp bin/bc "$OUT/bc.wasm"
ls -l "$OUT/bc.wasm"
echo "built with $WALI_TOOLCHAIN"
