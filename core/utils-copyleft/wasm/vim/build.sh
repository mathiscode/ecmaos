#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/vim.wasm: Vim for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali.
#
# The result is committed, so only run this to change it. One line of the Vim source is changed (below).
#
# What differs from a stock build, and why:
#  - the termcap is libecmaos-termcap.a (`core/utils/wasm/lib/ecmaos/termcap.c`), which never finds a terminal: there
#    is no terminal database, and Vim then uses its builtin xterm entries.
#  - `--with-features=normal`: Vimscript, folding, diff, quickfix, persistent undo and more. (`small`
#    in this Vim release builds the Tiny set, which has none of them.) `huge` adds only interpreters
#    and a GUI, none of which can work here. Syntax highlighting is compiled in and reads
#    the runtime subset that runtime.sh ships.
#  - `--prefix=/usr`: the compiled-in runtime directory is /usr/share/vim/vim91, where runtime.sh puts it.
#  - `USE_SYSTEM`: shell commands (`:!`, `:r !`, filters) go through `system()`, which musl runs as `/bin/sh -c` with
#    posix_spawn. Without it Vim forks, and there is no fork. With it os_unixx.h leaves out <sys/wait.h>, which
#    os_unix.c still needs (for waitpid), so it is included on the command line.
#  - `SYS_VIMRC_FILE=/etc/vimrc`: Vim reads its system vimrc from `$VIM`, which is not set here.
#  - `MODIFIED_BY=ecmaOS`: this is a modified Vim (ecmaOS's termcap is linked in), and the Vim license (II.3) requires
#    `:version` and the intro screen to say so; this define is what makes them print "Modified by ecmaOS".
#  - ui.c's `inchar_loop`, asked to look for a key without waiting, takes the time since it started off that wait and
#    waits forever when the result is below zero. On Linux the clock rarely moves a millisecond in between; here it
#    reads in whole milliseconds, so a look for a key often became a wait for one, and Vim stopped at its start, at
#    `:q` or before a `:!` command until a key came. The wait now stops at zero. The change is asserted below, so a
#    release that moves the line fails the build.
#  - `VIM_DEFAULTS_FILE=/etc/vimrc`: with no ~/.vimrc Vim sources `$VIMRUNTIME/defaults.vim`, which is
#    not shipped and would end every start with E1187. The vimrc guards against loading twice.
#  - configure cannot run its test programs here, so the answers they would give on Linux are passed in (vim_cv_*).
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
SOURCES="$HERE/../../scripts/sources.mjs"
VERSION=$(node "$SOURCES" version vim)
ARCHIVE=$(node "$SOURCES" fetch vim)
OUT=$HERE/../../programs/vim.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
tar xzf "$ARCHIVE"
mkdir ecmaos
"$WALI_CC" -O2 -c "$HERE/../../../utils/wasm/lib/ecmaos/termcap.c" -o ecmaos/termcap.o
"$WALI_AR" rcs ecmaos/libecmaos-termcap.a ecmaos/termcap.o

cd "vim-$VERSION/src"
old='	    wait_time -= elapsed_time;'
[ "$(grep -cxF -- "$old" ui.c)" = 1 ] || { echo "vim: expected exactly one '$old' in ui.c" >&2; exit 1; }
sed -i 's/^\t    wait_time -= elapsed_time;$/\t    wait_time = wait_time > elapsed_time ? wait_time - elapsed_time : 0;/' ui.c
grep -qxF '	    wait_time = wait_time > elapsed_time ? wait_time - elapsed_time : 0;' ui.c || { echo "vim: the ui.c change did not apply" >&2; exit 1; }
CC="$WALI_CC" LDFLAGS="-L$WORK/ecmaos" ./configure --host=wasm32-unknown-linux-musl --prefix=/usr --with-features=normal \
  --disable-gui --without-x --disable-nls --disable-selinux --disable-acl --disable-gpm --disable-sysmouse --disable-netbeans \
  --disable-channel --with-tlib=ecmaos-termcap vim_cv_toupper_broken=no vim_cv_terminfo=no vim_cv_tgetent=zero \
  vim_cv_getcwd_broken=no vim_cv_stat_ignores_slash=no vim_cv_memmove_handles_overlap=yes vim_cv_tty_group=world \
  vim_cv_tty_mode=0620 > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" vim \
  CFLAGS="-O2 -include sys/wait.h -DUSE_SYSTEM -DSYS_VIMRC_FILE=\\\"/etc/vimrc\\\" -DVIM_DEFAULTS_FILE=\\\"/etc/vimrc\\\" -DMODIFIED_BY=\\\"ecmaOS\\\"" \
  > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
cp vim "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
