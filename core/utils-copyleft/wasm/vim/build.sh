#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/vim.wasm: Vim for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
#
# What differs from a stock build, and why:
#  - `-sSTANDALONE_WASM=0`: an output named `.wasm` makes emscripten 6 standalone, which compiles
#    `ioctl` and `poll` to stubs. The ordinary build imports the real `env.__syscall_*` calls, which
#    `core/kernel/src/bin/wasi-preview1.mjs` answers against the tty.
#  - `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm`: setjmp/longjmp as wasm exceptions, so the module
#    does not import `invoke_*` helpers from emscripten's JS glue (the host has none).
#  - libecmaos (`core/utils/wasm/lib/ecmaos.sh`): what ecmaOS adds to Emscripten's libc - processes, the kernel's
#    signals reaching Vim's handlers (SIGWINCH, SIGINT and the rest), timers, and the xattr calls Emscripten lacks -
#    and its termcap that never finds a terminal (Vim then uses its builtin xterm entries).
#  - `--with-features=normal`: Vimscript, folding, diff, quickfix, persistent undo and more. (`small`
#    in this Vim release builds the Tiny set, which has none of them.) `huge` adds only interpreters
#    and a GUI, none of which can work here. Syntax highlighting is compiled in and reads
#    the runtime subset that runtime.sh ships.
#  - `--prefix=/usr`: the compiled-in runtime directory is /usr/share/vim/vim91, where runtime.sh puts it.
#  - `USE_SYSTEM`: shell commands (`:!`, `:r !`, filters) go through `system()`, which libecmaos runs as `/bin/sh -c`
#    with posix_spawn. Without it Vim forks, and there is no fork.
#  - `SYS_VIMRC_FILE=/etc/vimrc`: Vim reads its system vimrc from `$VIM`, which is not set here.
#  - `MODIFIED_BY=ecmaOS`: this is a modified Vim (libecmaos is linked in), and the Vim license (II.3) requires `:version` and the
#    intro screen to say so; this define is what makes them print "Modified by ecmaOS".
#  - `VIM_DEFAULTS_FILE=/etc/vimrc`: with no ~/.vimrc Vim sources `$VIMRUNTIME/defaults.vim`, which is
#    not shipped and would end every start with E1187. The vimrc guards against loading twice.
set -euo pipefail
"$(dirname "$0")/../../../../utils/check-emcc.sh"
source "$(dirname "$0")/../../../utils/wasm/lib/ecmaos.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version vim)
ARCHIVE=$(node "$SOURCES" fetch vim)
OUT=$HERE/../../programs/vim.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
build_ecmaos "$WORK"

cd "vim-$VERSION/src"
FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
LDFLAGS="$ECMAOS_LIBDIR $ECMAOS_LIB $ECMAOS_LDFLAGS" emconfigure ./configure --prefix=/usr --with-features=normal --disable-gui --without-x --disable-nls \
  --disable-selinux --disable-acl --disable-gpm --disable-sysmouse --disable-netbeans --disable-channel \
  --with-tlib=ecmaos-termcap vim_cv_toupper_broken=no vim_cv_terminfo=no vim_cv_tgetent=zero vim_cv_getcwd_broken=no \
  vim_cv_stat_ignores_slash=no vim_cv_memmove_handles_overlap=yes vim_cv_tty_group=world > configure.log 2>&1
emmake make -j"$(nproc)" vim CC=emcc \
  CFLAGS="$FLAGS -include sys/wait.h -DUSE_SYSTEM -DSYS_VIMRC_FILE=\\\"/etc/vimrc\\\" -DVIM_DEFAULTS_FILE=\\\"/etc/vimrc\\\" -DMODIFIED_BY=\\\"ecmaOS\\\"" \
  LDFLAGS="$ECMAOS_LIBDIR $ECMAOS_LIB $FLAGS -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_main,_fflush $ECMAOS_LDFLAGS" > make.log 2>&1
cp vim.wasm "$OUT"
ls -l "$OUT"
