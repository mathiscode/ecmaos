#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of Emscripten programs: builds libecmaos (ecmaos/*.c here), what ecmaOS adds to
# Emscripten's libc so a program gets processes and signals as Linux has them, from the kernel's process calls:
#  - posix_spawn and posix_spawnp, execve (and the exec family on it), waitpid, kill, popen and pclose, and the real
#    process ids; the spawn is the host call WALI programs make too, with the file actions and close-on-exec flags
#    applied as a forked child would (ecmaos/process.c)
#  - signals from the kernel run the program's handlers, a call they interrupt fails with EINTR or is restarted
#    (SA_RESTART), a default action ends or stops the process by the signal, alarm and setitimer raise SIGALRM, and
#    sleeps, pause and sigsuspend wait in the kernel (ecmaos/signal.c)
#  - extended attribute calls that answer ENOTSUP (ecmaos/gaps.c)
#  - libecmaos-termcap.a, a termcap with no terminal database, for a program that asks for it (ecmaos/termcap.c)
# The host side is core/kernel/src/bin/emscripten.mjs. fork stays unavailable (ENOSYS).
#
# build_ecmaos WORK builds into "$WORK/ecmaos" and sets, for the caller's link:
#   ECMAOS_LIB     the object to link (`emcc ... $ECMAOS_LIB`): it replaces libc's definitions, so it is an object,
#                  not an archive member that might not be pulled in
#   ECMAOS_LDFLAGS what the link needs besides: ecmaos/library.js, which declares the host calls so they stay imports
#   ECMAOS_LIBDIR  `-L` for libecmaos-termcap.a
set -euo pipefail

ECMAOS_SOURCES=$(cd "$(dirname "${BASH_SOURCE[0]}")/ecmaos" && pwd)

build_ecmaos() {
  local out=$1/ecmaos
  mkdir -p "$out"
  emcc -O2 -r "$ECMAOS_SOURCES/process.c" "$ECMAOS_SOURCES/signal.c" "$ECMAOS_SOURCES/gaps.c" -o "$out/ecmaos.o"
  emcc -O2 -c "$ECMAOS_SOURCES/termcap.c" -o "$out/termcap.o"
  emar rcs "$out/libecmaos-termcap.a" "$out/termcap.o"
  ECMAOS_LIB=$out/ecmaos.o
  ECMAOS_LDFLAGS="--js-library $ECMAOS_SOURCES/library.js"
  ECMAOS_LIBDIR=-L$out
}
