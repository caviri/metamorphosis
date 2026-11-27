#!/bin/sh
# Build the Rust compute kernel and copy it to web/wasm/kernel.wasm.
# Needs: rustup target add wasm32-unknown-unknown   (no wasm-pack, no wasm-bindgen)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/kernel"
RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown
mkdir -p "$ROOT/web/wasm"
cp target/wasm32-unknown-unknown/release/kernel.wasm "$ROOT/web/wasm/kernel.wasm"
ls -l "$ROOT/web/wasm/kernel.wasm"
