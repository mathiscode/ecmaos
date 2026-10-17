#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of programs that read keymaps (Wayland toolkit clients): builds libxkbcommon 1.13.2 (MIT)
# as a static library into "$1/prefix", without meson (the library is a list of C files and one bison grammar; the
# host needs `bison`). No xkb data files are installed: a keymap comes from text a program holds, such as the one a
# Wayland compositor sends (`xkb_keymap_new_from_buffer`), and `xkb_keymap_new_from_names` finds nothing to include.
# Sets XKBCOMMON_INC and XKBCOMMON_LIB for the caller.
set -euo pipefail

XKBCOMMON=1.13.2
XKBCOMMON_SHA256=acc4d5f7c3cbba5f9f8d08d8bdbeede84ecede46792f47929aa9321873385528

build_xkbcommon() {
  local work=$1
  command -v bison > /dev/null || { echo "xkbcommon: needs the host bison" >&2; exit 1; }
  ( cd "$work"
    curl -fsSL -o xkbcommon.tar.gz "https://github.com/xkbcommon/libxkbcommon/archive/refs/tags/xkbcommon-$XKBCOMMON.tar.gz"
    echo "$XKBCOMMON_SHA256  xkbcommon.tar.gz" | sha256sum -c -
    tar xzf xkbcommon.tar.gz
    mkdir -p prefix/include/xkbcommon prefix/lib
    cd "libxkbcommon-xkbcommon-$XKBCOMMON"
    mkdir -p gen
    cat > gen/config.h <<'CONFIG'
#define XLOCALEDIR "/usr/share/X11/locale"
#define DFLT_XKB_CONFIG_ROOT "/usr/share/X11/xkb"
#define DFLT_XKB_CONFIG_EXTRA_PATH "/etc/xkb"
#define DFLT_XKB_LEGACY_ROOT "/usr/share/X11/xkb"
#define DEFAULT_XKB_RULES "evdev"
#define DEFAULT_XKB_MODEL "pc105"
#define DEFAULT_XKB_LAYOUT "us"
#define DEFAULT_XKB_VARIANT NULL
#define DEFAULT_XKB_OPTIONS NULL
#define HAVE_UNISTD_H 1
#define HAVE_DIRENT_H 1
#define HAVE_XKB_EXTENSIONS_DIRECTORIES 1
#define HAVE___BUILTIN_EXPECT 1
#define HAVE_MMAP 1
#define HAVE_STRNDUP 1
#define HAVE_ASPRINTF 1
#define HAVE_VASPRINTF 1
#define HAVE_OPEN_MEMSTREAM 1
CONFIG
    # no Compose data is installed, so a program that asks for a locale's table is told there is none; that is not an error to print
    sed -i 's/log_err(ctx, XKB_ERROR_INVALID_COMPOSE_LOCALE,/log_dbg(ctx, XKB_ERROR_INVALID_COMPOSE_LOCALE,/' src/compose/table.c
    grep -q 'log_dbg(ctx, XKB_ERROR_INVALID_COMPOSE_LOCALE' src/compose/table.c || { echo "xkbcommon: the compose log patch did not apply" >&2; exit 1; }
    bison --defines=gen/parser.h -o gen/parser.c -p _xkbcommon_ src/xkbcomp/parser.y
    CFLAGS="-O2 -fwasm-exceptions -std=gnu11 -D_GNU_SOURCE -DHAVE_CONFIG_H -DENABLE_PRIVATE_APIS -Igen -I. -Isrc -Iinclude -Isrc/xkbcomp -Isrc/compose"
    for f in src/*.c src/xkbcomp/*.c src/compose/*.c gen/parser.c; do
      case $f in src/registry.c|src/compose/dump.c) continue ;; esac
      out=gen/$(echo "${f%.c}" | tr / _).o
      emcc $CFLAGS -c "$f" -o "$out" > "$out.log" 2>&1 || { tail -30 "$out.log" >&2; exit 1; }
    done
    emar rcs "$work/prefix/lib/libxkbcommon.a" gen/*.o
    cp include/xkbcommon/xkbcommon.h include/xkbcommon/xkbcommon-compat.h include/xkbcommon/xkbcommon-compose.h include/xkbcommon/xkbcommon-keysyms.h include/xkbcommon/xkbcommon-names.h "$work/prefix/include/xkbcommon/"
    mkdir -p "$work/prefix/lib/pkgconfig"
    printf 'Name: xkbcommon\nDescription: xkbcommon\nVersion: %s\nRequires:\nLibs: -L%s -lxkbcommon\nCflags: -I%s\n' \
      "$XKBCOMMON" "$work/prefix/lib" "$work/prefix/include" > "$work/prefix/lib/pkgconfig/xkbcommon.pc"
  )
  XKBCOMMON_INC="-I$work/prefix/include"
  XKBCOMMON_LIB="-L$work/prefix/lib -lxkbcommon"
}
