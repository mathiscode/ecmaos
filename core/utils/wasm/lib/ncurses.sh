#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of programs that use curses (ncdu, mg): builds ncurses 6.5 (X11 license) as a static
# wide-character library into "$1/prefix". There is no terminfo database here, so the entries for xterm, xterm-256color,
# vt100 and linux are compiled into the library (`--with-fallbacks`, which needs the host's `tic` and `infocmp`).
# The terminal's own name is `xterm.js`, which none of those match; a program that cares sets TERM itself first.
# Sets NCURSES_INC and NCURSES_LIB for the caller. Same build as ../../../utils-copyleft/wasm/nano/build.sh.
set -euo pipefail

NCURSES=6.5
NCURSES_SHA256=136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6

build_ncurses() {
  local work=$1
  ( cd "$work"
    curl -fsSL -o ncurses.tar.gz "https://ftp.gnu.org/gnu/ncurses/ncurses-$NCURSES.tar.gz"
    echo "$NCURSES_SHA256  ncurses.tar.gz" | sha256sum -c -
    tar xzf ncurses.tar.gz
    mkdir -p prefix
    cd "ncurses-$NCURSES"
    CC=emcc CFLAGS="-O2 -fwasm-exceptions" ./configure --host=wasm32-unknown-emscripten --prefix="$work/prefix" \
      --without-ada --without-cxx --without-cxx-binding --without-manpages --without-progs --without-tests \
      --without-shared --without-debug --disable-database --with-fallbacks=xterm-256color,xterm,vt100,linux \
      --with-tic-path="$(command -v tic)" --with-infocmp-path="$(command -v infocmp)" --without-gpm \
      --disable-stripping --enable-widec --disable-home-terminfo > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
    make -j"$(nproc)" libs > make.log 2>&1 || true # the last step builds a host-side helper that does not run
    [ -f lib/libncursesw.a ] || { tail -30 make.log >&2; exit 1; }
    make install.includes > /dev/null 2>&1
    mkdir -p "$work/prefix/lib" && cp lib/libncursesw.a "$work/prefix/lib/"
  )
  NCURSES_INC="-I$work/prefix/include -I$work/prefix/include/ncursesw"
  NCURSES_LIB="-L$work/prefix/lib"
}
