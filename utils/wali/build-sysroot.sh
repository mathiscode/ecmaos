#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Builds the WALI sysroot into $1: WALI's musl, the Linux UAPI headers, compiler-rt's builtins and libc++, libc++abi
# and libunwind, all for wasm32-linux-muslwali with WebAssembly exception handling (C++ exceptions and
# setjmp/longjmp) and threads, from the sources pinned in utils/wali-version and the patches in utils/wali/patches.
# Run by utils/check-wali.sh when the sysroot it wants is not there; nothing here is committed. Needs clang and
# wasm-ld of the pinned LLVM major, llvm-ar, llvm-ranlib, cmake, ninja, make, curl and xz.
#
#   utils/wali/build-sysroot.sh <dir> <wasm-ld>
set -euo pipefail

OUT=$1
LD=$2
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../wali-version
source "$HERE/../wali-version"
TARGET=wasm32-linux-muslwali
JOBS=$(nproc 2>/dev/null || echo 4)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE=$OUT.partial
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/resource/lib/$TARGET"

fetch() { # url sha256 file
  curl -fsSL -o "$WORK/$3" "$1"
  echo "$2  $WORK/$3" | sha256sum -c --quiet -
}

# The linker clang runs for this target is whatever `wasm-ld` it finds first, so the sysroot carries its own; the
# resource directory is clang's headers with compiler-rt's builtins for this target beside them.
ln -s "$LD" "$STAGE/bin/wasm-ld"
ln -s "$(clang -print-resource-dir)/include" "$STAGE/resource/include"

FEATURES="-mcpu=generic -matomics -mbulk-memory -mexception-handling"
# lrint and lround return a long, which is 8 bytes on this target; LLVM's WebAssembly backend calls them as the
# wasm32 ABI has them (a 4-byte long) where it lowers the builtins, which wasm-ld then cannot link, so they stay calls
NOLONG="-fno-builtin-lrint -fno-builtin-lrintf -fno-builtin-lrintl -fno-builtin-lround -fno-builtin-lroundf -fno-builtin-lroundl"
DRIVER="--target=$TARGET --sysroot=$STAGE -resource-dir=$STAGE/resource -B$STAGE/bin $FEATURES $NOLONG -fwasm-exceptions -pthread"
# setjmp/longjmp on wasm exceptions is a code generation option, so only a command that compiles takes it
SJLJ="-mllvm -wasm-enable-sjlj"
FLAGS="$DRIVER $SJLJ"

echo "wali: musl ${MUSL_COMMIT:0:12}" >&2
fetch "https://github.com/arjunr2/wali-musl/archive/$MUSL_COMMIT.tar.gz" "$MUSL_SHA256" musl.tar.gz
mkdir "$WORK/musl"
tar xzf "$WORK/musl.tar.gz" -C "$WORK/musl" --strip-components=1
for patch in "$HERE"/patches/musl/*.patch; do patch -s -p1 -d "$WORK/musl" < "$patch"; done
cat > "$WORK/musl/config.mak" <<EOF
ARCH = wasm32
prefix = $STAGE
includedir = \$(prefix)/include
libdir = \$(prefix)/lib/$TARGET
CC = clang
AR = llvm-ar
RANLIB = llvm-ranlib
SHARED_LIBS =
EOF
# musl compiles with -nostdinc, so its own flags are the target's and nothing of the sysroot's yet
make -s -C "$WORK/musl" -j"$JOBS" install-libs install-headers \
  CFLAGS="--target=$TARGET $FEATURES -fwasm-exceptions -mllvm -wasm-enable-sjlj -pthread" > "$WORK/musl.log" 2>&1 \
  || { tail -30 "$WORK/musl.log" >&2; exit 1; }

echo "wali: Linux UAPI headers $KERNEL_HEADERS_VERSION" >&2
fetch "https://github.com/sabotage-linux/kernel-headers/releases/download/v$KERNEL_HEADERS_VERSION/linux-headers-$KERNEL_HEADERS_VERSION.tar.xz" "$KERNEL_HEADERS_SHA256" headers.tar.xz
mkdir "$WORK/headers"
tar xJf "$WORK/headers.tar.xz" -C "$WORK/headers" --strip-components=1
# x86_64's: this target has its structures (a 64-bit kernel long) with 32-bit pointers, which the headers take as x32
make -s -C "$WORK/headers" ARCH=x86_64 prefix="$STAGE" install

echo "wali: LLVM $LLVM_VERSION runtimes" >&2
fetch "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/llvm-project-$LLVM_VERSION.src.tar.xz" "$LLVM_SHA256" llvm.tar.xz
mkdir "$WORK/llvm"
SRC=llvm-project-$LLVM_VERSION.src
tar xJf "$WORK/llvm.tar.xz" -C "$WORK/llvm" --strip-components=1 --wildcards \
  "$SRC/cmake/*" "$SRC/compiler-rt/*" "$SRC/libc/*" "$SRC/libcxx/*" "$SRC/libcxxabi/*" "$SRC/libunwind/*" \
  "$SRC/llvm/cmake/*" "$SRC/llvm/utils/lit/*" "$SRC/llvm/utils/llvm-lit/*" "$SRC/runtimes/*" "$SRC/third-party/*"
for patch in "$HERE"/patches/compiler-rt/*.patch; do patch -s -p1 -d "$WORK/llvm" < "$patch"; done

COMMON=(
  -G Ninja -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=wasm32
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_ASM_COMPILER=clang
  -DCMAKE_C_COMPILER_TARGET=$TARGET -DCMAKE_CXX_COMPILER_TARGET=$TARGET -DCMAKE_ASM_COMPILER_TARGET=$TARGET
  -DCMAKE_AR="$(command -v llvm-ar)" -DCMAKE_RANLIB="$(command -v llvm-ranlib)"
  -DCMAKE_C_COMPILER_WORKS=ON -DCMAKE_CXX_COMPILER_WORKS=ON
  -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_CXX_FLAGS="$FLAGS" -DCMAKE_ASM_FLAGS="$FLAGS"
  -DCMAKE_POSITION_INDEPENDENT_CODE=OFF
)

# crtbegin/crtend are for ELF's .init_array, which musl's own crt already covers on wasm
cmake -S "$WORK/llvm/compiler-rt/lib/builtins" -B "$WORK/builtins" "${COMMON[@]}" \
  -DCOMPILER_RT_BAREMETAL_BUILD=ON -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON -DCOMPILER_RT_BUILD_CRT=OFF \
  -DCOMPILER_RT_INCLUDE_TESTS=OFF -DCOMPILER_RT_HAS_FPIC_FLAG=OFF -DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON \
  > "$WORK/builtins.log" 2>&1 || { tail -30 "$WORK/builtins.log" >&2; exit 1; }
ninja -C "$WORK/builtins" >> "$WORK/builtins.log" 2>&1 || { tail -30 "$WORK/builtins.log" >&2; exit 1; }
cp "$WORK/builtins/lib/wasm32-unknown-linux-muslwali/libclang_rt.builtins.a" "$STAGE/resource/lib/$TARGET/"
# clang looks the builtins up by the triple it normalised the target to
ln -s "$TARGET" "$STAGE/resource/lib/wasm32-unknown-linux-muslwali"

cmake -S "$WORK/llvm/runtimes" -B "$WORK/cxx" "${COMMON[@]}" \
  -DCMAKE_INSTALL_PREFIX="$STAGE" -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi;libunwind" -DLLVM_INCLUDE_TESTS=OFF \
  -DLIBCXX_INSTALL_LIBRARY_DIR="lib/$TARGET" -DLIBCXXABI_INSTALL_LIBRARY_DIR="lib/$TARGET" -DLIBUNWIND_INSTALL_LIBRARY_DIR="lib/$TARGET" \
  -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_EXCEPTIONS=ON -DLIBCXX_ENABLE_FILESYSTEM=ON -DLIBCXX_ENABLE_THREADS=ON \
  -DLIBCXX_HAS_MUSL_LIBC=ON -DLIBCXX_HAS_PTHREAD_API=ON -DLIBCXX_CXX_ABI=libcxxabi -DLIBCXX_ENABLE_ABI_LINKER_SCRIPT=OFF \
  -DLIBCXX_INCLUDE_TESTS=OFF -DLIBCXX_INCLUDE_BENCHMARKS=OFF \
  -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_EXCEPTIONS=ON -DLIBCXXABI_ENABLE_THREADS=ON \
  -DLIBCXXABI_HAS_PTHREAD_API=ON -DLIBCXXABI_USE_LLVM_UNWINDER=ON -DLIBCXXABI_ENABLE_STATIC_UNWINDER=ON \
  -DLIBCXXABI_INCLUDE_TESTS=OFF \
  -DLIBUNWIND_ENABLE_SHARED=OFF -DLIBUNWIND_ENABLE_THREADS=ON -DLIBUNWIND_HIDE_SYMBOLS=ON -DLIBUNWIND_INCLUDE_TESTS=OFF \
  > "$WORK/cxx.log" 2>&1 || { tail -30 "$WORK/cxx.log" >&2; exit 1; }
ninja -C "$WORK/cxx" install >> "$WORK/cxx.log" 2>&1 || { tail -30 "$WORK/cxx.log" >&2; exit 1; }

# What a build passes as CC and CXX: one command each, so configure scripts and makefiles can take them as they are.
# The link flags are left off a compile (-c, -S, -E) and the code generation option off a link of objects alone,
# where clang would warn that they went unused. A program they link gets a signal check in each loop
# (signal-checks.mjs, kept beside them).
cp "$(dirname "$0")/signal-checks.mjs" "$STAGE/bin/signal-checks.mjs"
for tool in cc c++; do
  driver=clang; extra=""
  [ "$tool" = c++ ] && driver=clang++ && extra="-stdlib=libc++"
  cat > "$STAGE/bin/wali-$tool" <<EOF
#!/bin/sh
# Generated by utils/wali/build-sysroot.sh: $driver for WALI with this sysroot.
# the function table is exported so the host can call the signal handlers the program installs, and the memory is
# imported (wali.memory) so each thread's instance can be given the same one; the main thread has Linux's 8 MiB
# stack (wasm-ld's default, 64 KiB, overflows below address 0 in programs written for Linux)
link="-Wl,--shared-memory -Xlinker --import-memory=wali,memory -Wl,--export-memory -Wl,--export-table -Wl,--max-memory=2147483648 -Wl,-z,stack-size=8388608"
sjlj=
out=a.out
next=
for arg in "\$@"; do
  [ -n "\$next" ] && out=\$arg && next=
  case "\$arg" in
    -c|-S|-E|-M|-MM) link= ;;
    -x|*.c|*.cc|*.cpp|*.cxx|*.C|*.c++|*.i|*.ii|-) sjlj="$SJLJ" ;;
    -o) next=1 ;;
    -o*) out=\${arg#-o} ;;
  esac
done
$driver $DRIVER $extra \$sjlj "\$@" \$link || exit
# each loop of the program looks for signals now and then, so they reach it while it computes
[ -z "\$link" ] || [ ! -f "\$out" ] || node "$STAGE/bin/signal-checks.mjs" "\$out"
EOF
  # the paths in it are the staging directory's until it is moved into place
  sed -i "s#$STAGE#$OUT#g" "$STAGE/bin/wali-$tool"
  chmod +x "$STAGE/bin/wali-$tool"
done

rm -rf "$OUT"
mv "$STAGE" "$OUT"
# the links into the resource directory and the linker point at absolute paths outside it, so only the wrappers moved
echo "wali: sysroot in $OUT" >&2
