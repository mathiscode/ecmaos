#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rebuilds programs/bash.wasm: GNU Bash, for ecmaOS, on WALI's musl (`utils/check-wali.sh`), run by /bin/wali. bash forks
# for every command, pipeline, subshell, command substitution and process substitution, so the compiler rewrites it with
# Asyncify (utils/wali/asyncify.sh), which is why it needs Binaryen's wasm-opt. The result is committed, so only run
# this to change it.
#
# Asyncify is told where bash's calls through a pointer reach fork. Left to itself it would rewrite every function that
# calls through a pointer, and their callers (1.97 MB against 1.57 MB). bash runs its builtins through a pointer
# (execute_builtin_or_function and its subshell twin, and `eval`, `source`, `command` and `builtin` among them run
# commands), expands words through one (expand_word_list_internal, whose `$(...)` forks), runs the actions of its unwind
# stack and traps, and reads a line through readline's key dispatch (a binding can run a command: `bind -x`, C-x C-e).
# A function missed here traps in the child of a fork under it, when it rewinds; bash.test.ts has a script for each of
# these. That needs the program's function names, which wasm-ld leaves out of a program linked with -O2, so bash is
# compiled with it and linked (again) without.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"

HERE=$(cd "$(dirname "$0")" && pwd)
VERSION=$(node "$HERE/../../scripts/sources.mjs" version bash)
ARCHIVE=$(node "$HERE/../../scripts/sources.mjs" fetch bash)
OUT=$HERE/../../programs
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

INDIRECT=execute_builtin_or_function,execute_subshell_builtin_or_function,execute_simple_command,builtin_builtin,\
evalfile_internal,edit_and_execute_command,unwind_frame_run_internal,run_unwind_protects,exit_shell,\
expand_word_list_internal,assign_in_env,expand_string_if_necessary,waitchld,handler,\
readline,readline_internal_setup,readline_internal_char,_rl_dispatch_subseq,rl_execute_named_command

cd "$WORK"
tar xzf "$ARCHIVE"
cd "bash-$VERSION"

# configure's -Wl,--fatal-warnings turns wasm-ld's signature warning for each function probe into a failure (as for dash)
sed -i 's/-Wl,--fatal-warnings//' configure
# main takes (argc, argv, env), which the C library's start does not call: a main of three parameters is not
# __main_argc_argv. The environment is `environ` all the same.
sed -i 's/^main (int argc, char \*\*argv, char \*\*env)$/main (int argc, char **argv)/; s/^  int code, old_errexit_flag;$/  int code, old_errexit_flag;\n  extern char **environ;\n  char **env = environ;/' shell.c
grep -q 'char \*\*env = environ' shell.c || { echo "bash: shell.c has no main to patch" >&2; exit 1; }

# the bundled readline and termcap, and bash's own allocator off (musl's is the one the sysroot has). The tools it builds
# to run at build time (mkbuiltins, ...) are for this machine, and want a C older than the C23 that `bool` is a keyword in.
CC="$WALI_CC" AR=llvm-ar RANLIB=llvm-ranlib CFLAGS="-O2 -w" \
  ./configure --host=wasm32-linux-musl --without-bash-malloc --disable-nls --enable-static-link --without-curses \
  > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
ECMAOS_WALI_NO_ASYNCIFY=1 make -j"$(nproc)" CC_FOR_BUILD="cc -std=gnu17" > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
rm bash
ECMAOS_WALI_ASYNCIFY_INDIRECT=$INDIRECT make CFLAGS=-w CC_FOR_BUILD="cc -std=gnu17" > link.log 2>&1 || { tail -30 link.log >&2; exit 1; }
grep -a "^wali:" link.log >&2 || true
cp bash "$OUT/bash.wasm"
ls -l "$OUT/bash.wasm"
echo "built with $WALI_TOOLCHAIN"
