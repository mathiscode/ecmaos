#!/usr/bin/env bash
# Rebuilds programs/bat.wasm: bat, cat with syntax highlighting and paging (through less), for ecmaOS, in Rust on WALI's musl (utils/wali/rust.sh), run by /bin/wali. The
# crate is built as published, with its Cargo.lock, and the license of every crate it uses is kept in licenses/bat/.
# Built without git support (its change markers need libgit2). The result is committed, so only run this to change it.
set -euo pipefail
source "$(dirname "$0")/../../../../utils/check-wali.sh"
source "$(dirname "$0")/../../../../utils/wali/rust.sh"

VERSION=0.26.1
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../programs/bat.wasm
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
curl -fsSL -A 'ecmaos-build' -o bat.crate "https://static.crates.io/crates/bat/bat-$VERSION.crate"
SHA256=$(cat "$HERE/bat.sha256")
echo "$SHA256  bat.crate" | sha256sum -c -
tar xzf bat.crate
cd "bat-$VERSION"
# the minimal application: no libgit2; Oniguruma, its C regex library, is built by wali-cc
wali_cargo --no-default-features --features minimal-application > build.log 2>&1 || { tail -30 build.log >&2; exit 1; }
wali_check_imports target/wasm32-wali-linux-musl/release/bat.wasm
cp target/wasm32-wali-linux-musl/release/bat.wasm "$OUT"
rm -rf "$HERE/../../licenses/bat" && wali_rust_licenses "$HERE/../../licenses/bat" --no-default-features --features minimal-application
ls -l "$OUT"
echo "built with $WALI_TOOLCHAIN and $(rustup run "$RUST_TOOLCHAIN" rustc --version)"
