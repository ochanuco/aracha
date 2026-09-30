#!/usr/bin/env bash
# Copies the cha WASM package and contract vectors from a cha checkout (built with its scripts/build-wasm.sh).
set -euo pipefail
cha="${1:?usage: scripts/vendor-cha.sh <path to cha checkout>}"
dest="$(cd "$(dirname "$0")/.." && pwd)/vendor/cha"
mkdir -p "$dest/vectors"
cp "$cha"/pkg/cha_wasm.js "$cha"/pkg/cha_wasm_bg.wasm "$cha"/pkg/cha_wasm.d.ts "$cha"/pkg/cha_wasm_bg.wasm.d.ts "$dest/"
cp "$cha"/tests/vectors/*.json "$dest/vectors/"
