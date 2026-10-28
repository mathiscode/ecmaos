#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/fortune.wasm and programs/fortune-data.tar.gz: fortune from fortune-mod 3.24.0 (BSD-4-Clause-UC,
# Berkeley's license, whose advertising clause the University withdrew in 1999), for ecmaOS, on WALI's musl
# (`utils/check-wali.sh`), run by /bin/wali. The source is unmodified, and built without CMake: config.h is written
# here, and rinutils (COUNT, LAST and GCC_UNUSED, all fortune and strfile use of it) by three lines. -m searches with musl's
# regex; recode is left out (it only converts the cookies' charset, and they are UTF-8 already).
#
# The data is a tarball rooted at / that installs to /usr/share/games/fortunes: the cookie files and the index strfile
# makes of each (`NAME.dat`, built here with a host strfile from the same source). Not all of fortune-mod's files are
# shipped: none of the offensive ones (`off/`, which -o asks for, so -o finds none), and none that are mostly quotations of
# one copyrighted work or of song lyrics (songs-poems, pratchett, startrek, the-x-files-taglines, rules-of-acquisition),
# nor drugs, ethnic, men-women, politics, debian, disclaimer and translate-me.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

VERSION=3.24.0
SHA256=0cb889a124994377190800b2d70cf2254791049c8ba55d7570f91936d38c85ad
COOKIES="art ascii-art computers cookie definitions education food fortunes goedel humorists kids knghtbrd law linux
  literature love magic medicine miscellaneous news paradoxum people perl pets platitudes riddles science shlomif-fav
  sports tao wisdom work zippy"
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/fortune.wasm
DATA=$HERE/../../programs/fortune-data.tar.gz
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o fortune-mod.tar.gz "https://github.com/shlomif/fortune-mod/archive/refs/tags/fortune-mod-$VERSION.tar.gz"
echo "$SHA256  fortune-mod.tar.gz" | sha256sum -c -
tar xzf fortune-mod.tar.gz
cd "fortune-mod-fortune-mod-$VERSION/fortune-mod"

mkdir -p shim/rinutils
printf '#define COUNT(arr) (sizeof(arr) / sizeof(arr[0]))\n#define LAST(arr) ((arr)[COUNT(arr) - 1])\n' > shim/rinutils/count.h
echo '#define GCC_UNUSED __attribute__((unused))' > shim/rinutils/unused.h
cat > shim/config.h <<CONFIG
#pragma once
#define VERSION "$VERSION"
#define FORTDIR "/usr/share/games/fortunes"
#define OFFDIR "/usr/share/games/fortunes/off"
#define LOCFORTDIR "/usr/local/share/games/fortunes"
#define LOCOFFDIR "/usr/local/share/games/fortunes/off"
CONFIG
FLAGS="-O2 -Ishim -Iutil -DHAVE_REGEX_H"
"$WALI_CC" $FLAGS -o fortune.wasm fortune/fortune.c
cc $FLAGS -o strfile util/strfile.c
cp fortune.wasm "$OUT"

DIR=$WORK/image/usr/share/games/fortunes
mkdir -p "$DIR"
for cookie in $COOKIES; do
  cp "datfiles/$cookie" "$DIR/$cookie"
  ./strfile -s "$DIR/$cookie" "$DIR/$cookie.dat"
done
tar -C "$WORK/image" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - usr/share/games | gzip -9n > "$DATA"
mkdir -p "$HERE/../../licenses/fortune" && cp COPYING.txt "$HERE/../../licenses/fortune/COPYING"
ls -l "$OUT" "$DATA"
echo "built with $WALI_TOOLCHAIN"
