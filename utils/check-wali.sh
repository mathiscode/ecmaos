# shellcheck shell=bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced first by every build script that compiles for WALI (a program run by /bin/wali on WALI's musl). Checks the
# compiler, builds the sysroot pinned in `utils/wali-version` if it is not there yet (`utils/wali/build-sysroot.sh`,
# a few minutes, once), and sets:
#
#   WALI_CC, WALI_CXX   the compilers, as single commands with the target, sysroot and link flags in them
#   WALI_AR, WALI_RANLIB
#   WALI_SYSROOT        where the headers and libraries are, for a build that needs to name them
#   WALI_TOOLCHAIN      a line naming what built the binary, for its source offer
#
# The sysroot lives in $ECMAOS_WALI_HOME (default ~/.cache/ecmaos/wali), in a directory named for a hash of the pins,
# the patches, the build script and the signal checks wali-cc adds to each program (wali/signal-checks.mjs, run with
# node), so changing any of them builds a new one. clang must be the pinned LLVM major;
# `ECMAOS_WALI_ANY=1` builds with another one anyway. wasm-ld is $WALI_LD, else the first on PATH, else emscripten's.

_wali_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=wali-version
source "$_wali_dir/wali-version"

_wali_major=${LLVM_VERSION%%.*}
_wali_clang=$(clang --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ "${_wali_clang%%.*}" != "$_wali_major" ] && [ -z "${ECMAOS_WALI_ANY:-}" ]; then
  echo "clang ${_wali_clang:-not found}: WALI programs are built with LLVM $_wali_major (utils/wali-version). Set ECMAOS_WALI_ANY=1 to build with this one anyway." >&2
  return 1 2>/dev/null || exit 1
fi
for _wali_tool in llvm-ar llvm-ranlib cmake ninja make curl xz patch node; do
  command -v "$_wali_tool" > /dev/null || { echo "check-wali: $_wali_tool not found" >&2; return 1 2>/dev/null || exit 1; }
done

_wali_ld=${WALI_LD:-$(command -v wasm-ld || true)}
if [ -z "$_wali_ld" ] && command -v em-config > /dev/null; then
  _wali_ld=$(em-config LLVM_ROOT 2>/dev/null)/wasm-ld
  [ -x "$_wali_ld" ] || _wali_ld=
  [ -n "$_wali_ld" ] && echo "check-wali: no wasm-ld on PATH, using emscripten's ($_wali_ld); installing lld $_wali_major gives a matching one" >&2
fi
if [ -z "$_wali_ld" ]; then
  echo "check-wali: wasm-ld not found (install lld $_wali_major, or set WALI_LD)" >&2
  return 1 2>/dev/null || exit 1
fi
_wali_ld_version=$("$_wali_ld" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1 || true)

_wali_key=$(cat "$_wali_dir/wali-version" "$_wali_dir/wali/build-sysroot.sh" "$_wali_dir/wali/signal-checks.mjs" "$_wali_dir"/wali/patches/*/*.patch | sha256sum | cut -c1-16)
WALI_SYSROOT=${ECMAOS_WALI_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/ecmaos/wali}/$_wali_key
if [ ! -x "$WALI_SYSROOT/bin/wali-cc" ]; then
  mkdir -p "$(dirname "$WALI_SYSROOT")"
  "$_wali_dir/wali/build-sysroot.sh" "$WALI_SYSROOT" "$_wali_ld" || return 1 2>/dev/null || exit 1
fi

export WALI_SYSROOT
export WALI_CC=$WALI_SYSROOT/bin/wali-cc
export WALI_CXX=$WALI_SYSROOT/bin/wali-c++
export WALI_AR=llvm-ar
export WALI_RANLIB=llvm-ranlib
export WALI_TOOLCHAIN="WALI musl ${MUSL_COMMIT:0:12} and LLVM $LLVM_VERSION runtimes, clang $_wali_clang, wasm-ld ${_wali_ld_version:-unknown}"
unset _wali_dir _wali_major _wali_clang _wali_tool _wali_ld _wali_ld_version _wali_key
