#!/usr/bin/env bash
# Rebuilds programs/fd.wasm: fd, the friendly find, for ecmaOS, in Rust on WALI's musl (utils/wali/rust.sh), run by /bin/wali. The
# crate is built as published, with its Cargo.lock, and the license of every crate it uses is kept in licenses/fd/.
# The result is committed, so only run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"
source "$(dirname "$0")/../../../../utils/wali/rust.sh"

VERSION=10.5.0
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/fd.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -A 'ecmaos-build' -o fd-find.crate "https://static.crates.io/crates/fd-find/fd-find-$VERSION.crate"
SHA256=$(cat "$HERE/fd-find.sha256")
echo "$SHA256  fd-find.crate" | sha256sum -c -
tar xzf fd-find.crate
cd "fd-find-$VERSION"
wali_cargo > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
wali_check_imports target/wasm32-wali-linux-musl/release/fd.wasm
cp target/wasm32-wali-linux-musl/release/fd.wasm "$OUT"
rm -rf "$HERE/../../licenses/fd" && wali_rust_licenses "$HERE/../../licenses/fd"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN and $(rustup run "$RUST_TOOLCHAIN" rustc --version)"
