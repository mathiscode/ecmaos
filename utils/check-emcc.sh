#!/usr/bin/env bash
# Called first by every wasm build script. The source offer in `licenses/<program>/SOURCE` names the toolchain
# that made each binary, so a rebuild with another one would make that statement untrue: stop unless asked not to.
# The pinned version is in `utils/emscripten-version`; `ECMAOS_EMCC_ANY=1` builds anyway (then update the pin and
# `toolchain` in both `programs/manifest.json` files before committing the result).
set -euo pipefail
want=$(tr -d '[:space:]' < "$(dirname "${BASH_SOURCE[0]}")/emscripten-version")
have=$(emcc --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ "$have" != "$want" ] && [ -z "${ECMAOS_EMCC_ANY:-}" ]; then
  echo "emcc ${have:-not found}: these programs are built with Emscripten $want (utils/emscripten-version). Set ECMAOS_EMCC_ANY=1 to build with this one anyway." >&2
  exit 1
fi
