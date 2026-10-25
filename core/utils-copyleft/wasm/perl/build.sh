#!/usr/bin/env bash
# SPDX-License-Identifier: Artistic-1.0-Perl OR GPL-1.0-or-later
# Rebuilds programs/perl.wasm and programs/perl-lib.tar.gz: Perl 5.44 for ecmaOS, on WALI's musl (`utils/check-wali.sh`),
# run by /bin/wali. fork, system, backticks and pipe opens work, so the compiler rewrites the program with Asyncify
# (utils/wali/asyncify.sh), which is why it needs Binaryen's wasm-opt. The result is committed, so only run this to
# change it.
#
# - Perl's own Configure runs programs it has just built, which a WebAssembly program cannot be on the build machine,
#   so this is a cross build with perl-cross (https://github.com/arsv/perl-cross), an overlay on the Perl source that
#   brings its own configure and Makefile. It builds a miniperl for the build machine to generate files with.
# - The extensions are linked into the program (there is no dlopen): POSIX, Socket, IO, Fcntl, Storable, Digest::MD5,
#   Digest::SHA, Encode, List::Util, Time::HiRes and the rest of the core set. Compress::Raw::Zlib and Bzip2 are left
#   out, and so is ext/re: its regex engine is built a second time with the symbols of the first, which a static link
#   refuses (`use re 'debug'` is what that costs; the other things `use re` does are in the interpreter).
# - configure reads the size of a type from the symbol table of an object file with `readelf --syms`. A WebAssembly
#   object is not ELF, so a small readelf stands in for it that prints llvm-nm's sizes in readelf's layout.
# - -DNO_ENV_ARRAY_IN_MAIN: perlmain's main() takes (argc, argv) so that clang's WebAssembly target gives it the
#   __main_argc_argv name that musl's startup calls; a main with an env argument is not found. The byte order is given
#   (WebAssembly is little endian and the integers are 64 bits: 12345678), as configure cannot run a program to find it.
# - -fwrapv -fno-strict-aliasing: perl-cross adds them for gcc only; Perl's source relies on both, with clang as well.
# - Perl's own Configure runs a probe for the form of setlocale(LC_ALL, NULL), which this cannot; perl-cross assumes
#   glibc's LC_CTYPE=..;LC_NUMERIC=.. pairs, and musl's is positional: the six names in the order of its categories,
#   separated by ';' (C.UTF-8;C;C;C;C;C). Without these, Perl panics at start-up on the first locale it reads.
# - The library is a tarball rooted at /, unpacked to /usr/lib/perl5/5.44.0 (the program's prefix is /usr), with the
#   documentation (.pod), the headers and static archives for building extensions, ExtUtils and CPAN left out.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
PERL=$(node "$SOURCES" version perl perl)
CROSS=$(node "$SOURCES" version perl perl-cross)
PERL_ARCHIVE=$(node "$SOURCES" fetch perl perl)
CROSS_ARCHIVE=$(node "$SOURCES" fetch perl perl-cross)
OUT=$HERE/../../programs/perl.wasm
LIB=$HERE/../../programs/perl-lib.tar.gz
WORK=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT

cd "$WORK"
tar xJf "$PERL_ARCHIVE"
mv "perl-$PERL" src
tar xzf "$CROSS_ARCHIVE" -C src --strip-components=1

mkdir tools
cat > tools/readelf <<'SH'
#!/bin/sh
[ "$1" = --syms ] || exit 1
shift
llvm-nm -S --defined-only "$@" | while read -r _ size _ name; do
  [ -n "$name" ] && printf '%6d: %016d %5d OBJECT  GLOBAL DEFAULT    3 %s\n' 1 0 "$((0x$size))" "$name"
done
SH
chmod +x tools/readelf

cd src
READELF="$WORK/tools/readelf" NM=llvm-nm OBJDUMP=llvm-objdump \
  ./configure --target=wasm32-linux-musl --prefix=/usr --with-cc="$WALI_CC" --with-ranlib="$WALI_RANLIB" -Dar="$WALI_AR" \
  -Dusedl=undef -Dbyteorder=12345678 -Accflags="-D_GNU_SOURCE -DNO_ENV_ARRAY_IN_MAIN" -Doptimize="-O2 -fwrapv -fno-strict-aliasing" -Dinc_version_list=none \
  -Ud_perl_lc_all_uses_name_value_pairs -Dd_perl_lc_all_separator=define -Dperl_lc_all_separator='";"' \
  -Dd_perl_lc_all_category_positions_init=define -Dperl_lc_all_category_positions_init='{ 0, 1, 2, 3, 4, 5 }' \
  -Dman1dir=none -Dman3dir=none -Dcf_email=perl@ecmaos --all-static \
  --disable-mod=ext/re,cpan/Compress-Raw-Zlib,cpan/Compress-Raw-Bzip2 > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" > make.log 2>&1 || { grep -a -B2 -A6 'error' make.log | head -40 >&2; exit 1; }
# make builds a static extension's archive and not its .pm files (it only touches the stamp that says they were copied),
# so they are copied to lib/ here, where install finds them
for dir in $(find ext cpan dist -mindepth 2 -maxdepth 3 -name Makefile -printf '%h\n' | sort); do
  [ -f "$dir/Makefile.PL" ] || continue
  rm -f "$dir/pm_to_blib"
  make -C "$dir" PERL_CORE=1 pm_to_blib > /dev/null 2>&1 || { echo "perl: $dir: pm_to_blib failed" >&2; exit 1; }
done
make install DESTDIR="$WORK/image" > install.log 2>&1 || { tail -30 install.log >&2; exit 1; }

LIBDIR=$WORK/image/usr/lib/perl5/$PERL
( cd "$LIBDIR"
  rm -rf pod CPAN CPAN.pm ExtUtils wasm32-linux/CORE perl5db.pl
  find . -name '*.pod' -delete
  find . \( -name '*.a' -o -name '*.bs' -o -name .packlist \) -delete
  find . -type d -empty -delete )
tar -C "$WORK/image" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - "usr/lib/perl5" | gzip -9n > "$LIB"

cp perl "$OUT"
ls -l "$OUT" "$LIB"
echo "built with $WALI_TOOLCHAIN"
