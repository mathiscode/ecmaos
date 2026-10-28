#!/usr/bin/env bash
# Rebuilds programs/rg.wasm: ripgrep for ecmaOS, in Rust on WALI's musl (utils/wali/rust.sh), run by /bin/wali. The
# crate is built as published, with its Cargo.lock, and the license of every crate it uses is kept in licenses/rg/.
# The result is committed, so only run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"
source "$(dirname "$0")/../../../../utils/wali/rust.sh"

VERSION=15.2.0
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/rg.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -A 'ecmaos-build' -o ripgrep.crate "https://static.crates.io/crates/ripgrep/ripgrep-$VERSION.crate"
SHA256=$(cat "$HERE/ripgrep.sha256")
echo "$SHA256  ripgrep.crate" | sha256sum -c -
tar xzf ripgrep.crate
cd "ripgrep-$VERSION"
wali_cargo > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
wali_check_imports target/wasm32-wali-linux-musl/release/rg.wasm
cp target/wasm32-wali-linux-musl/release/rg.wasm "$OUT"
rm -rf "$HERE/../../licenses/rg" && wali_rust_licenses "$HERE/../../licenses/rg"
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN and $(rustup run "$RUST_TOOLCHAIN" rustc --version)"
