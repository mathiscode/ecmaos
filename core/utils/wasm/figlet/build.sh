#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/figlet.wasm and programs/figlet-fonts.tar.gz: FIGlet 2.2.5 (BSD-3-Clause), the large-letter
# banner maker, for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali. The source is unmodified; the
# fonts and control files it ships are the runtime, a tarball rooted at / that installs to /usr/share/figlet, the
# program's default font directory. utf8.h uses glibc's __BEGIN_DECLS, which musl has not got, so it is defined empty.
# chkfont, figlist and showfigfonts are not built.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=2.2.5
SHA256=4d366c4a618ecdd6fdb81cde90edc54dbff9764efb635b3be47a929473f13930
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/figlet.wasm
FONTS=$HERE/../../programs/figlet-fonts.tar.gz
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o figlet.tar.gz "https://github.com/cmatsuoka/figlet/archive/refs/tags/$VERSION.tar.gz"
echo "$SHA256  figlet.tar.gz" | sha256sum -c -
tar xzf figlet.tar.gz
cd "figlet-$VERSION"

make -j"$(nproc)" CC="$WALI_CC" CFLAGS="-O2 -D__BEGIN_DECLS= -D__END_DECLS=" LD="$WALI_CC" LDFLAGS="" prefix=/usr figlet > make.log 2>&1 || { grep -m5 error: make.log >&2; tail -5 make.log >&2; exit 1; }
cp figlet "$OUT"

mkdir -p "$WORK/image/usr/share/figlet"
cp fonts/*.flf fonts/*.flc "$WORK/image/usr/share/figlet/"
tar -C "$WORK/image" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - usr/share/figlet | gzip -9n > "$FONTS"
mkdir -p "$HERE/../../licenses/figlet" && cp LICENSE "$HERE/../../licenses/figlet/LICENSE"
ls -l "$OUT" "$FONTS"
echo "built with $WALI_TOOLCHAIN"
