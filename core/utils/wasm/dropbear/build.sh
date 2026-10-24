#!/usr/bin/env bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Rebuilds programs/dropbear.wasm: Dropbear 2026.94 for ecmaOS, on WALI's musl (`utils/check-wali.sh`) with zlib
# (../lib/zlib.sh), run by /bin/wali. One multi-call program: `dropbear` is the server, and ssh (also dbclient), scp and
# dropbearkey are links to it that it tells apart by the name it was run as. It forks (a connection, a proxy command,
# a session's child), so the compiler rewrites it with Asyncify (utils/wali/asyncify.sh), which is why it needs
# Binaryen's wasm-opt. The result is committed, so only run this to change it.
# Dropbear carries its own crypto (libtomcrypt and libtommath), so there is no OpenSSL. PAM, utmp, wtmp and lastlog are
# off, and so is the server's re-exec. The source is unmodified.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"
source "$(dirname "$0")/../lib/zlib.sh"

VERSION=2026.94
SHA256=e098034a843699200c8c977a991fff73159735bf795d5f72ef672c41a6b1ae81
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/dropbear.wasm
WORK=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || rm -rf "$WORK"' EXIT

cd "$WORK"
build_zlib "$WORK"
curl -fsSL -o dropbear.tar.bz2 "https://matt.ucc.asn.au/dropbear/releases/dropbear-$VERSION.tar.bz2"
echo "$SHA256  dropbear.tar.bz2" | sha256sum -c -
tar xjf dropbear.tar.bz2
cd "dropbear-$VERSION"
# libtomcrypt makes ulong32 an `unsigned long` unless it knows the platform has a 64-bit long, and WALI's is (its
# pointers are 32 bits, which it checks for by name): ciphers that rely on 32-bit wrap-around (chacha, poly1305) then
# give wrong answers. A wasm target is told to use `unsigned`.
python3 - <<'PY'
p = "libtomcrypt/src/headers/tomcrypt_cfg.h"
s = open(p).read()
old = "    defined(__LP64__) || defined(_LP64) || defined(__64BIT__)\n   typedef unsigned ulong32;"
assert old in s, "libtomcrypt changed: no ulong32 list"
s = s.replace(old, "    defined(__LP64__) || defined(_LP64) || defined(__64BIT__) || defined(__wasm__)\n   typedef unsigned ulong32;", 1)
open(p, "w").write(s)
PY
# A user's shell in ecmaOS's /etc/passwd can be `ecmaos`, the login shell the kernel provides, which is a name and not a
# program to run; the session runs /bin/sh (the same shell) for it, as for an empty shell.
python3 - <<'PY'
p = "src/common-session.c"
s = open(p).read()
old = "if (ses.authstate.pw_shell[0] == '\\0') {"
assert old in s, "dropbear changed: get_user_shell"
s = s.replace(old, "if (ses.authstate.pw_shell[0] != '/') {", 1)
open(p, "w").write(s)
PY
# The server re-executes itself for each connection (to re-randomise its address space); a wasm module has no address
# space to randomise, and the fallback after a failed fexecve loses the connection's socket. scp runs ssh from /bin.
printf '#define DROPBEAR_REEXEC 0\n#define DROPBEAR_PATH_SSH_PROGRAM "/bin/ssh"\n%s\n' "${EXTRA_LOCAL:-}" > localoptions.h
CC="$WALI_CC" AR="$WALI_AR" RANLIB="$WALI_RANLIB" CFLAGS="-O2 -w $ZLIB_INC" LDFLAGS="$ZLIB_LIB" \
  ./configure --host=wasm32-linux-musl --enable-static --enable-bundled-libtom --with-zlib="$WORK/prefix" \
  --disable-pam --disable-lastlog --disable-utmp --disable-utmpx --disable-wtmp --disable-wtmpx \
  --disable-pututline --disable-pututxline > configure.log 2>&1 || { tail -30 configure.log >&2; exit 1; }
make -j"$(nproc)" PROGRAMS="dropbear dbclient dropbearkey scp" MULTI=1 > make.log 2>&1 || { tail -30 make.log >&2; exit 1; }
grep -a "^wali:" make.log >&2 || true
cp dropbearmulti "$OUT"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN"
