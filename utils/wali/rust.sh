# shellcheck shell=bash
# SPDX-License-Identifier: MIT OR Apache-2.0
# Sourced by the build scripts of Rust programs, after utils/check-wali.sh. Builds with the nightly pinned in
# utils/rust-wali-version for wasm32-wali-linux-musl, linked by wali-cc (the clang driver flavor, so its link flags and
# the signal checks and Asyncify it adds apply) against the WALI sysroot's musl, std built along (-Z build-std).
#
#   wali_cargo [cargo build arguments]    build in the current crate; the program is target/wasm32-wali-linux-musl/release/
#   wali_rust_licenses OUT_DIR            the license texts of every crate the build used, one file per crate, in OUT_DIR
#
# std asks for a backtrace through libunwind, which WebAssembly cannot walk; a stub that finds no frames stands in, and a
# program checks after linking that nothing is left for the host to supply (`env` imports). rustix, which many crates
# use, makes raw syscalls on the architectures it knows, which wasm32 is not; it is told to go through libc.

_rust_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=../rust-wali-version
source "$_rust_dir/rust-wali-version"
command -v rustup > /dev/null || { echo "rust.sh: rustup not found" >&2; return 1 2>/dev/null || exit 1; }
rustup run "$RUST_TOOLCHAIN" rustc --version > /dev/null 2>&1 || { echo "rust.sh: install the toolchain: rustup toolchain install $RUST_TOOLCHAIN --component rust-src" >&2; return 1 2>/dev/null || exit 1; }
[ -d "$(rustup run "$RUST_TOOLCHAIN" rustc --print sysroot)/lib/rustlib/src/rust/library" ] || { echo "rust.sh: add rust-src: rustup component add rust-src --toolchain $RUST_TOOLCHAIN" >&2; return 1 2>/dev/null || exit 1; }

_rust_std_lock="$(rustup run "$RUST_TOOLCHAIN" rustc --print sysroot)/lib/rustlib/src/rust/library/Cargo.lock"
_rust_stub=$(mktemp -d)/unwind_stub.o
# _URC_END_OF_STACK (5) at once, and no frame, address or function for the questions a backtrace asks of a frame
cat > "${_rust_stub%.o}.c" <<'STUB'
typedef unsigned long uintptr;
int _Unwind_Backtrace(void *trace, void *arg) { (void)trace; (void)arg; return 5; }
uintptr _Unwind_GetIP(void *context) { (void)context; return 0; }
uintptr _Unwind_GetIPInfo(void *context, int *before) { (void)context; if (before) *before = 0; return 0; }
uintptr _Unwind_GetCFA(void *context) { (void)context; return 0; }
void *_Unwind_FindEnclosingFunction(void *pc) { (void)pc; return 0; }
uintptr _Unwind_GetRegionStart(void *context) { (void)context; return 0; }
uintptr _Unwind_GetLanguageSpecificData(void *context) { (void)context; return 0; }
uintptr _Unwind_GetDataRelBase(void *context) { (void)context; return 0; }
uintptr _Unwind_GetTextRelBase(void *context) { (void)context; return 0; }
STUB
"$WALI_CC" -c -O2 "${_rust_stub%.o}.c" -o "$_rust_stub"

# Crates that many others use know Linux only on the architectures they list, and wasm32 is not one: linux-raw-sys,
# which rustix takes Linux's constants and structures from, and rustix's own ioctl encoding; and mio refuses every wasm
# target but WASI, where on WALI its Unix code applies. And libc gives SIG_IGN as 1, Linux's, where WALI's musl has -2
# (a table can hold a function at index 1): std ignores SIGPIPE at start, which would have made the host take function 1
# for its handler. The libc std is built with is patched too, so every program needs the patches. WALI uses the x86_64 kernel
# ABI with 32-bit pointers, which is x32's, so wasm32 is given x32's linux-raw-sys modules and the x86 family's ioctl
# numbers: each version the crate locks is copied, edited, and patched in through the crate's .cargo/config.toml.
_WALI_PATCHES=(
  'linux-raw-sys|src/lib.rs|s/all(target_arch = "x86_64", target_pointer_width = "32")/any(all(target_arch = "x86_64", target_pointer_width = "32"), target_arch = "wasm32")/g; s/^\(\s*\)target_arch = "x86_64",$/\1target_arch = "x86_64",\n\1target_arch = "wasm32",/'
  'rustix|src/ioctl/linux.rs|s/^\(\s*\)target_arch = "x86_64",$/\1target_arch = "x86_64",\n\1target_arch = "wasm32",/'
  'mio|src/lib.rs|s/^#\[cfg(all(target_family = "wasm", not(target_os = "wasi")))\]$/#[cfg(all(target_family = "wasm", not(target_os = "wasi"), not(target_os = "linux")))]/'
  'libc|src/unix/mod.rs|s/^pub const SIG_IGN: sighandler_t = 1 as sighandler_t;$/#[cfg(not(all(target_arch = "wasm32", target_os = "linux")))]\npub const SIG_IGN: sighandler_t = 1 as sighandler_t;\n\/\/ WALI'"'"'s musl: a WebAssembly table can have a function at index 1, so ignoring a signal is -2\n#[cfg(all(target_arch = "wasm32", target_os = "linux"))]\npub const SIG_IGN: sighandler_t = -2isize as sighandler_t;/'
)

wali_patch_crates() {
  # once is enough: a second build in the same tree keeps the patches it has
  grep -q '\.wali-patches/' .cargo/config.toml 2>/dev/null && return 0
  cargo "+$RUST_TOOLCHAIN" fetch --locked > /dev/null 2>&1 || true
  local entry name file edit version dir copy n=0 patched=
  mkdir -p .cargo .wali-patches
  for entry in "${_WALI_PATCHES[@]}"; do
    IFS='|' read -r name file edit <<< "$entry"
    for version in $(awk -v want="$name" '$0 == "name = \"" want "\"" { getline; gsub(/version = |"/, ""); print }' Cargo.lock "$_rust_std_lock" | sort -u); do
      dir=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/"$name-$version" 2>/dev/null | head -1)
      [ -n "$dir" ] || { echo "rust.sh: $name $version was not fetched" >&2; return 1; }
      [ -f "$dir/$file" ] || continue
      copy="$PWD/.wali-patches/$name-$version"
      rm -rf "$copy" && cp -r "$dir" "$copy" && chmod -R u+w "$copy"
      sed -i "$edit" "$copy/$file"
      # a version the edit finds nothing in needs none (mio 0.8 has no refusal), and is left as it is
      if cmp -s "$dir/$file" "$copy/$file"; then rm -rf "$copy"; continue; fi
      # a crate's own config may not end its last line
      [ -n "$patched" ] || { printf '\n[patch.crates-io]\n' >> .cargo/config.toml; patched=1; }
      echo "$name-wali-$n = { path = \"$copy\", package = \"$name\" }" >> .cargo/config.toml
      n=$((n + 1))
    done
  done
}

wali_cargo() {
  # The libc crate learned WALI's ABI (64-bit long, as wali-cc's clang has it) in a later 0.2 than many crates lock; one
  # that predates it takes this target for 32-bit and calls musl with the wrong signatures, which wasm-ld turns into
  # traps (`sysconf_bitcast_invalid`). So every libc in the lock becomes the one std is built with, and with the
  # patches below that is the only change to the lock: the other versions stay as they were.
  local locked= std_libc version
  std_libc=$(awk '/^name = "libc"$/ { getline; gsub(/version = |"/, ""); print; exit }' "$_rust_std_lock")
  for version in $(awk '/^name = "libc"$/ { getline; gsub(/version = |"/, ""); print }' Cargo.lock 2>/dev/null | sort -u); do
    [ "$version" = "$std_libc" ] || cargo "+$RUST_TOOLCHAIN" update -q -p "libc@$version" --precise "$std_libc" || return 1
  done
  wali_patch_crates || return 1
  CARGO_TARGET_WASM32_WALI_LINUX_MUSL_LINKER="$WALI_CC" CC_wasm32_wali_linux_musl="$WALI_CC" AR_wasm32_wali_linux_musl="$WALI_AR" \
  RUSTFLAGS="-Z unstable-options -C target-feature=+atomics,+bulk-memory,+exception-handling -C link-self-contained=no -C linker-flavor=wasm-lld-cc -C link-arg=$_rust_stub --cfg rustix_use_libc" \
    cargo "+$RUST_TOOLCHAIN" build --release $locked -Z build-std=std,panic_abort --target wasm32-wali-linux-musl "$@"
}

# A program the host could not start: one that imports what the WALI host has not got
wali_check_imports() {
  node -e 'const m = new WebAssembly.Module(require("fs").readFileSync(process.argv[1])); const bad = WebAssembly.Module.imports(m).filter(i => i.module !== "wali").map(i => `${i.module}.${i.name}`); if (bad.length) { console.error(`${process.argv[1]}: imports what the WALI host has not got: ${bad.join(" ")}`); process.exit(1) }' "$1"
}

wali_rust_licenses() {
  # the crates the program is built from: normal and build dependencies for this target, with the features the build
  # used (the arguments after OUT_DIR), not the ones only its tests use
  local out=$1; shift
  mkdir -p "$out"
  local used
  used=$(cargo "+$RUST_TOOLCHAIN" tree --target wasm32-wali-linux-musl -e normal,build --prefix none -f '{p}' "$@" | sed 's/ (.*//; s/ /@/' | sort -u)
  cargo "+$RUST_TOOLCHAIN" metadata --format-version 1 | node -e '
    const fs = require("fs"), path = require("path")
    const meta = JSON.parse(fs.readFileSync(0, "utf8"))
    const used = new Set(process.argv[2].split("\n").filter(Boolean).map(line => line.replace(/@v/, "@")))
    for (const pkg of meta.packages) {
      if (!used.has(`${pkg.name}@${pkg.version}`)) continue
      const dir = path.dirname(pkg.manifest_path)
      const texts = fs.readdirSync(dir).filter(name => /^(LICEN[CS]E|COPYING|UNLICENSE|COPYRIGHT|NOTICE)/i.test(name)).sort()
      const body = texts.map(name => `---- ${name}\n\n${fs.readFileSync(path.join(dir, name), "utf8").trim()}\n`).join("\n")
      fs.writeFileSync(path.join(process.argv[1], `${pkg.name}-${pkg.version}`), `${pkg.name} ${pkg.version} (${pkg.license ?? "see the texts"})\n${pkg.repository ?? ""}\n\n${body || "(the crate ships no license file; its license is the one named above)\n"}`)
    }' "$out" "$used"
}
