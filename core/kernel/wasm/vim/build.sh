#!/usr/bin/env bash
# Rebuilds src/bin/wasm/vim.wasm: Vim for ecmaOS, with emscripten.
#
# Needs `emcc` (emscripten 6). The result is committed, so only run this to change it.
#
# What differs from a stock build, and why:
#  - `-sSTANDALONE_WASM=0`: an output named `.wasm` makes emscripten 6 standalone, which compiles
#    `ioctl` and `poll` to stubs. The ordinary build imports the real `env.__syscall_*` calls, which
#    `src/bin/wasi-preview1.mjs` answers against the tty.
#  - `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm`: setjmp/longjmp as wasm exceptions, so the module
#    does not import `invoke_*` helpers from emscripten's JS glue (the host has none).
#  - `libc-gaps.c`: a termcap that never finds a terminal (Vim then uses its builtin xterm entries)
#    and the xattr calls musl lacks.
#  - `--with-features=normal`: Vimscript, folding, diff, quickfix, persistent undo and more. (`small`
#    in this Vim release builds the Tiny set, which has none of them.) `huge` adds only interpreters
#    and a GUI, none of which can work here. Syntax highlighting is compiled in and reads
#    the runtime subset that runtime.sh ships.
#  - `--prefix=/usr`: the compiled-in runtime directory is /usr/share/vim/vim91, where runtime.sh puts it.
#  - `USE_SYSTEM`: shell commands (`:!`, `:r !`, filters) go through `system()`, which the host answers by
#    spawning `/bin/ecmash -c` (see `_emscripten_system` in wasi-preview1.mjs). Without it Vim forks.
#  - `_ecmaos_signal` (libc-gaps.c) is how the host delivers SIGWINCH and the others to Vim's handlers.
#  - `SYS_VIMRC_FILE=/etc/vimrc`: Vim reads its system vimrc from `$VIM`, which is not set here.
#  - `VIM_DEFAULTS_FILE=/etc/vimrc`: with no ~/.vimrc Vim sources `$VIMRUNTIME/defaults.vim`, which is
#    not shipped and would end every start with E1187. The vimrc guards against loading twice.
set -euo pipefail

VERSION=9.1.0
SHA256=ddb435f6e386c53799a3025bdc5a3533beac735a0ee596cb27ada97366a1c725
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../src/bin/wasm/vim.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -o vim.tar.gz "https://github.com/vim/vim/archive/refs/tags/v$VERSION.tar.gz"
echo "$SHA256  vim.tar.gz" | sha256sum -c -
tar xzf vim.tar.gz
emcc -c -O2 "$HERE/libc-gaps.c" -o libc-gaps.o
emar rcs libtstub.a libc-gaps.o

cd "vim-$VERSION/src"
FLAGS="-O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
LDFLAGS="-L$WORK" emconfigure ./configure --prefix=/usr --with-features=normal --disable-gui --without-x --disable-nls \
  --disable-selinux --disable-acl --disable-gpm --disable-sysmouse --disable-netbeans --disable-channel \
  --with-tlib=tstub vim_cv_toupper_broken=no vim_cv_terminfo=no vim_cv_tgetent=zero vim_cv_getcwd_broken=no \
  vim_cv_stat_ignores_slash=no vim_cv_memmove_handles_overlap=yes vim_cv_tty_group=world > configure.log 2>&1
emmake make -j"$(nproc)" vim CC=emcc \
  CFLAGS="$FLAGS -include sys/wait.h -DUSE_SYSTEM -DSYS_VIMRC_FILE=\\\"/etc/vimrc\\\" -DVIM_DEFAULTS_FILE=\\\"/etc/vimrc\\\"" \
  LDFLAGS="-L$WORK $FLAGS -sSTANDALONE_WASM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sEXPORTED_FUNCTIONS=_main,_fflush,_ecmaos_signal" > make.log 2>&1
cp vim.wasm "$OUT"
ls -l "$OUT"
