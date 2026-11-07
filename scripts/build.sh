#!/usr/bin/env bash
# Build the koi for the browser: compile the wrapper to wasm32 and generate the
# JavaScript glue with wasm-bindgen into web/pkg.
#
# wasm-bindgen-cli must be exactly the wasm-bindgen crate version in Cargo.lock:
#   cargo install wasm-bindgen-cli --version "$(scripts/build.sh --wasm-bindgen-version)" --locked
set -euo pipefail
cd "$(dirname "$0")/.."

locked_version=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)
if [[ "${1:-}" == "--wasm-bindgen-version" ]]; then
  echo "$locked_version"
  exit 0
fi
installed_version=$(wasm-bindgen --version | awk '{ print $2 }')
if [[ "$installed_version" != "$locked_version" ]]; then
  echo "wasm-bindgen-cli is $installed_version but Cargo.lock has $locked_version;" >&2
  echo "run: cargo install wasm-bindgen-cli --version $locked_version --locked" >&2
  exit 1
fi

cargo build --release --locked --target wasm32-unknown-unknown -p pond-wasm
rm -rf web/pkg
wasm-bindgen --target web --no-typescript --out-dir web/pkg \
  target/wasm32-unknown-unknown/release/pond_wasm.wasm
ls -l web/pkg
