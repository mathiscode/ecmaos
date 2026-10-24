#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Rebuilds programs/aplay.wasm, arecord.wasm, amixer.wasm and speaker-test.wasm: ALSA's command line tools (alsa-utils
# 1.2.16) on alsa-lib 1.2.16.1 (LGPL-2.1-or-later, linked in), for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by
# /bin/wali. They talk to the sound card the audio driver offers under /dev/snd (see devices/audio). The result is
# committed, so only run this to change it.
#
# aplay and arecord are one program, which looks at the name it was run as; arecord.wasm is aplay.wasm again.
#
# alsa-lib is built as a static library with the plugins a card that moves samples by read and write needs (plug, rate,
# route, linear, copy, mmap_emul, softvol, ...) and without what is no use here (the sequencer, rawmidi, hwdep, topology,
# the use-case manager, plugins loaded with dlopen). It looks for its configuration in /usr/share/alsa/alsa.conf, which
# the initfs has.
#
# What is changed in the source, each asserted so a new release that moves the code fails the build:
#   - alsa-lib's include/local.h says the linker is GNU ld, and so puts a `.gnu.warning.<symbol>` section in the object
#     for each deprecated function; WebAssembly's assembler has no such directive, so the line is removed
#   - alsa-lib's include/alsa-symbols.h makes the public name of a function that has a versioned internal one (`snd_pcm_
#     hw_params_set_rate_near` for `__snd_pcm_hw_params_set_rate_near`) with `.weak` and `.set` assembler directives,
#     which WebAssembly's assembler drops without a word, leaving the name undefined; it is made with a weak alias instead
# Build-time helpers that run on the host (the autotools' timestamps) are kept from regenerating the configure scripts.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
LIB_ARCHIVE=$(node "$SOURCES" fetch aplay alsa-lib)
UTILS_ARCHIVE=$(node "$SOURCES" fetch aplay alsa-utils)
LIB_VERSION=$(node "$SOURCES" version aplay alsa-lib)
UTILS_VERSION=$(node "$SOURCES" version aplay alsa-utils)
PROGRAMS=$HERE/../../programs
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xjf "$LIB_ARCHIVE"
tar xjf "$UTILS_ARCHIVE"
PREFIX=$WORK/prefix
mkdir -p "$PREFIX/lib"

# the archives are newer than their generated files in the wrong order, which makes `make` run autoconf; it is not needed
quiet_autotools() { find "$1" \( -name aclocal.m4 -o -name configure -o -name Makefile.in -o -name config.h.in \) -exec touch {} +; }
NO_AUTOTOOLS=(ACLOCAL=true AUTOCONF=true AUTOMAKE=true AUTOHEADER=true)

cd "$WORK/alsa-lib-$LIB_VERSION"
python3 - <<'PY'
p = 'include/local.h'
s = open(p).read()
old = "#define HAVE_GNU_LD\n"
assert s.count(old) == 1, "alsa-lib changed: HAVE_GNU_LD not found in include/local.h"
open(p, 'w').write(s.replace(old, ''))

p = 'include/alsa-symbols.h'
s = open(p).read()
old = '''#define use_symbol_version(real, name, version) /* nothing */
#if defined(__alpha__) || defined(__mips__)
#define use_default_symbol_version(real, name, version) \\
	__asm__ (".weak " ASM_NAME(#name)); \\
	__asm__ (ASM_NAME(#name) " = " ASM_NAME(#real))
#else
#define use_default_symbol_version(real, name, version) \\
	__asm__ (".weak " ASM_NAME(#name)); \\
	__asm__ (".set " ASM_NAME(#name) "," ASM_NAME(#real))
#endif
'''
assert s.count(old) == 1, "alsa-lib changed: use_default_symbol_version not found in include/alsa-symbols.h"
new = '''#define use_symbol_version(real, name, version) /* nothing */
#define use_default_symbol_version(real, name, version) \\
	extern __typeof (real) name __attribute__((weak, alias(#real)))
'''
open(p, 'w').write(s.replace(old, new))
PY
quiet_autotools .
CC="$WALI_CC" CFLAGS=-O2 AR="$WALI_AR" RANLIB="$WALI_RANLIB" ./configure --host=wasm32-unknown-linux-musl \
  --prefix="$PREFIX" --disable-shared --enable-static --disable-python --disable-topology --disable-ucm --disable-seq \
  --disable-rawmidi --disable-hwdep --disable-aload --disable-old-symbols --without-versioned --disable-resmgr \
  --with-libdl=no --with-configdir=/usr/share/alsa --with-plugindir=/usr/lib/alsa-lib \
  --with-pcm-plugins="copy linear route mulaw alaw rate plug multi null empty meter hooks lfloat mmap_emul asym softvol" \
  --with-ctl-plugins="" > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -C src -j"$(nproc)" "${NO_AUTOTOOLS[@]}" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
make -C include install "${NO_AUTOTOOLS[@]}" > install.log 2>&1 || { tail -30 install.log >&2; exit 1; }
cp src/.libs/libasound.a "$PREFIX/lib/"

cd "$WORK/alsa-utils-$UTILS_VERSION"
quiet_autotools .
CC="$WALI_CC" CFLAGS="-O2 -I$PREFIX/include" LDFLAGS="-L$PREFIX/lib" AR="$WALI_AR" RANLIB="$WALI_RANLIB" ./configure \
  --host=wasm32-unknown-linux-musl --prefix="$PREFIX" --disable-alsatest --disable-bat --disable-alsamixer \
  --disable-alsaconf --disable-alsaloop --disable-nhlt --disable-xmlto --disable-rst2man --disable-nls \
  --with-alsa-prefix="$PREFIX/lib" --with-alsa-inc-prefix="$PREFIX/include" --without-curses \
  --without-systemdsystemunitdir --without-udev-rules-dir > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
for dir in aplay amixer speaker-test; do
  make -C "$dir" "${NO_AUTOTOOLS[@]}" LIBS="-lasound -lm -lpthread" > "make-$dir.log" 2>&1 || { tail -30 "make-$dir.log" >&2; exit 1; }
done
cp aplay/aplay "$PROGRAMS/aplay.wasm"
cp aplay/aplay "$PROGRAMS/arecord.wasm"
cp amixer/amixer "$PROGRAMS/amixer.wasm"
cp speaker-test/speaker-test "$PROGRAMS/speaker-test.wasm"
ls -l "$PROGRAMS"/{aplay,arecord,amixer,speaker-test}.wasm
echo "built with $WALI_TOOLCHAIN"
